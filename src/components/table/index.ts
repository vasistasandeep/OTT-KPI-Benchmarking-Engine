/**
 * Public entry point for reusable table components (task 19.1).
 *
 * Re-exports the virtualized high-density table so record and breakdown views
 * can compose it without reaching into file paths.
 */

export {
  VirtualizedTable,
  type VirtualizedTableProps,
} from "./VirtualizedTable";
