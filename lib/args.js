import { DEFAULT_GAS } from "./constants.js";

export const COMMON_FLAG_DEFAULTS = {
  csv: "",
  delayMin: 1,
  delayMax: 3,
  dryRun: false,
  yes: false,
  gasPriceGwei: DEFAULT_GAS.pgpGwei,
};

/**
 * Parse shared CLI flags.
 * onUnknown(arg, argv, index, args) returns:
 *   - number: new loop index after consuming flag value(s)
 *   - true: handled flag with no value
 *   - false/undefined: not handled
 */
export function parseCommonFlags(argv, { defaults = {}, onUnknown } = {}) {
  const args = { ...COMMON_FLAG_DEFAULTS, ...defaults };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--csv":
        args.csv = argv[++i];
        break;
      case "--delay-min":
        args.delayMin = Number(argv[++i]);
        break;
      case "--delay-max":
        args.delayMax = Number(argv[++i]);
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--yes":
        args.yes = true;
        break;
      case "--gas-price-gwei":
        args.gasPriceGwei = Number(argv[++i]);
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        if (onUnknown) {
          const nextIndex = onUnknown(arg, argv, i, args);
          if (nextIndex === true) {
            break;
          }
          if (typeof nextIndex === "number") {
            i = nextIndex;
            break;
          }
        }
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}
