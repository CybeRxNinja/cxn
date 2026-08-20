/**
 * OTLP telemetry export bootstrap.
 *
 * omp's agent core (`@cyberxninja-omp/pi-agent-core`) emits OpenTelemetry GenAI
 * spans through the global `@opentelemetry/api` tracer, and exposes run-level
 * callbacks for metrics/log pipelines. This module resolves the standard
 * `OTEL_*` env contract (endpoint, exporter selection, protocol,
 * `OTEL_SDK_DISABLED`) and, only when at least one signal has an OTLP endpoint,
 * loads `./telemetry-export-otlp` to register the trace/log/metric providers —
 * keeping the OTel SDK + exporter module graph (~100ms) out of default startup.
 *
 * Only the `http/protobuf` transport is supported — an
 * `OTEL_EXPORTER_OTLP*_PROTOCOL` of `grpc` or `http/json` declines rather than
 * misrouting protobuf payloads.
 */
import type {
	AgentRunCoverage,
	AgentRunSummary,
	AgentTelemetryConfig,
	AgentTelemetryWarning,
	ChatUsageEvent,
	ToolStatus,
} from "@cyberxninja-omp/pi-agent-core";
import { logger, postmortem } from "@cyberxninja-omp/pi-utils";
import {
	type Attributes,
	type AttributeValue,
	type Counter,
	context,
	type Histogram,
	type Meter,
	metrics,
} from "@opentelemetry/api";
import { type LogAttributes, logs, type Logger as OtelLogger, SeverityNumber } from "@opentelemetry/api-logs";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { detectResources, envDetector, resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

/**
 * Periodic flush interval. A long-lived `omp` process (the ACP server is
 * spawned once and reused across many turns) would otherwise hold finished
 * telemetry until a batch window elapses or the process exits.
 */
const FLUSH_INTERVAL_MS = 30_000;

const SERVICE_NAME = "omp";

type TelemetrySignal = "trace" | "log" | "metric";
type OtelLogLevel = "none" | logger.LogLevel;

interface SignalConfig {
	readonly trace: boolean;
	readonly log: boolean;
	readonly metric: boolean;
}

type TelemetrySignal = "trace" | "log" | "metric";

/** Loaded OTLP implementation module; `undefined` until a signal registers. */
interface OtlpExportModule {
	registerProviders(signalConfig: TelemetrySignalConfig): Promise<void>;
	isTelemetryExportEnabled(): boolean;
	createTelemetryExportConfig(config: AgentTelemetryConfig | undefined): AgentTelemetryConfig | undefined;
	flushTelemetryExport(): Promise<void>;
}

let otlp: OtlpExportModule | undefined;
let initPromise: Promise<void> | undefined;

/**
 * Whether {@link initTelemetryExport} registered any real OTLP signal provider.
 * The CLI uses this to decide whether to switch on the agent loop's telemetry
 * hooks; metrics and structured logs need those callbacks even when traces are
 * disabled.
 */
export function isTelemetryExportEnabled(): boolean {
	return otlp?.isTelemetryExportEnabled() ?? false;
}

/**
 * Merge OTLP metrics/log hooks into an existing agent telemetry config.
 *
 * The caller still owns content-capture policy, cost estimation, and custom
 * attributes. This only appends host-level metrics/log forwarding for the
 * providers registered by {@link initTelemetryExport}; a passthrough when
 * export is disabled.
 */
export function createTelemetryExportConfig(
	config: AgentTelemetryConfig | undefined,
): AgentTelemetryConfig | undefined {
	return otlp ? otlp.createTelemetryExportConfig(config) : config;
}

/**
 * Register global trace/log/meter providers when OTLP endpoints are configured
 * through env. Idempotent, and a no-op when no signal has an endpoint (or when
 * the OTEL kill-switches are engaged), so startup can call it unconditionally.
 */
export async function initTelemetryExport(): Promise<void> {
	if (initPromise) return initPromise;

	if (process.env.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true") return;

	const signalConfig = resolveSignalConfig();
	if (!signalConfig.trace && !signalConfig.log && !signalConfig.metric) return;

	initPromise = (async () => {
		// Branch-only: the OTel SDK + OTLP exporter graph loads only when an endpoint is configured.
		const impl: OtlpExportModule = await import("./telemetry-export-otlp");
		await impl.registerProviders(signalConfig);
		otlp = impl;
	})();
	return initPromise;
}

async function registerProviders(signalConfig: SignalConfig): Promise<void> {
	// `envDetector` parses OTEL_RESOURCE_ATTRIBUTES (percent-decoded, per spec) and
	// OTEL_SERVICE_NAME; merged last so both take precedence over the fallback
	// service.name — with OTEL_SERVICE_NAME still winning service.name inside the
	// detector itself.
	const resource = resourceFromAttributes({ "service.name": SERVICE_NAME }).merge(
		detectResources({ detectors: [envDetector] }),
	);

	if (signalConfig.trace) {
		const exporter = new OTLPTraceExporter();
		traceProvider = new NodeTracerProvider({
			resource,
			spanProcessors: [new BatchSpanProcessor(exporter)],
		});
		traceProvider.register({ contextManager: new AsyncLocalStorageContextManager().enable() });
	}

	if (signalConfig.metric) {
		const exporter = new OTLPMetricExporter();
		meterProvider = new MeterProvider({
			resource,
			readers: [new PeriodicExportingMetricReader({ exporter })],
		});
		metrics.setGlobalMeterProvider(meterProvider);
		metricRecorder = new AgentMetricRecorder(metrics.getMeter("@cyberxninja-omp/pi-coding-agent"));
	}

	if (signalConfig.log) {
		const exporter = new OTLPLogExporter();
		logProvider = new LoggerProvider({
			resource,
			processors: [new BatchLogRecordProcessor({ exporter })],
		});
		logs.setGlobalLoggerProvider(logProvider);
		otelLogger = logProvider.getLogger("@cyberxninja-omp/pi-coding-agent");
		unregisterLogSink = logger.registerLogSink(event => {
			emitOtelLog(
				event.level,
				event.message,
				logAttributesFromContext(event.context),
				"pi.omp.log",
				event.timestamp,
			);
		});
	}

	const flushTimer = setInterval(() => {
		flushTelemetryExport().catch(() => {});
	}, FLUSH_INTERVAL_MS);
	flushTimer.unref();

	postmortem.register("otel-export", async () => {
		clearInterval(flushTimer);
		unregisterLogSink?.();
		unregisterLogSink = undefined;
		const shutdowns: Promise<void>[] = [];
		if (traceProvider) shutdowns.push(traceProvider.shutdown());
		if (logProvider) shutdowns.push(logProvider.shutdown());
		if (meterProvider) shutdowns.push(meterProvider.shutdown());
		await Promise.all(shutdowns);
	});
}

function resolveSignalConfig(): TelemetrySignalConfig {
	return {
		trace: signalEnabled(
			"trace",
			process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
			process.env.OTEL_TRACES_EXPORTER,
			process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? process.env.OTEL_EXPORTER_OTLP_PROTOCOL,
		),
		log: signalEnabled(
			"log",
			process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
			process.env.OTEL_LOGS_EXPORTER,
			process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL ?? process.env.OTEL_EXPORTER_OTLP_PROTOCOL,
		),
		metric: signalEnabled(
			"metric",
			process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
			process.env.OTEL_METRICS_EXPORTER,
			process.env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL ?? process.env.OTEL_EXPORTER_OTLP_PROTOCOL,
		),
	};
}

function signalEnabled(
	signal: TelemetrySignal,
	endpoint: string | undefined,
	exporterSelection: string | undefined,
	protocolSelection: string | undefined,
): boolean {
	if (exporterSelection) {
		for (const entry of exporterSelection.split(",")) {
			if (entry.trim().toLowerCase() === "none") return false;
		}
	}
	if (!endpoint) return false;

	const protocol = protocolSelection?.trim().toLowerCase();
	if (protocol && protocol !== "http/protobuf") {
		logger.warn(`OTEL ${signal} export disabled: OTEL_EXPORTER_OTLP_PROTOCOL=${protocol} is unsupported`, {
			supported: "http/protobuf",
		});
		return false;
	}
	return true;
}
