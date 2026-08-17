{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.cxn;
in
{
  options.programs.cxn = {
    enable = lib.mkEnableOption "CXN coding agent";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "inputs.cxn.packages.${pkgs.stdenv.hostPlatform.system}.default";
      description = "CXN package to install system-wide.";
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ cfg.package ];
  };
}
