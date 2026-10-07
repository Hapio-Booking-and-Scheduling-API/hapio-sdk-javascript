/**
 * Formats a date the way the Hapio API expects timestamps: `YYYY-MM-DDThh:mm:ss+00:00`
 * (UTC, no milliseconds). Throws a `TypeError` for an invalid date.
 */
export declare function formatTimestamp(date: Date): string;
