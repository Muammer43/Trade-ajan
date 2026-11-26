/** "YYYY-MM-DD HH:MM:SS" in UTC, the form Twelve Data's start_date/end_date take. */
export function formatTwelveDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 19).replace("T", " ");
}
