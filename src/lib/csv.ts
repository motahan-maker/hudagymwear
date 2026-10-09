// CSV export (Blob download, no backend). Columns in English, Excel-friendly.
import { toast } from 'sonner';
export function escapeCell(v: unknown): string {
  let s = v == null ? '' : String(v);
  // Formula-injection guard: neutralise cells Excel would execute as formulas.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function toCSV(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '';
  const heads = Object.keys(rows[0] ?? {});
  return [heads.join(','), ...rows.map((r) => heads.map((h) => escapeCell(r[h])).join(','))].join('\n');
}
export function downloadCSV(filename: string, rows: Record<string, unknown>[]) {
  if (!rows.length) { toast.info('No rows to export.'); return; }
  const csv = toCSV(rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
