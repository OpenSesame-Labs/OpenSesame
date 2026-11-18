/** Bounds and shared response reader for file parts. */
export { readDriveBody as readPartResponse } from "./drive-body.js";

export const MAX_DRIVE_PART_LIST_BYTES = 2 * 1024 * 1024;
export const MAX_DRIVE_PARTS = 65_536;
