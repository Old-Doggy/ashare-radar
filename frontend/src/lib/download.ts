/** 文件导出工具。
 *
 * `toCsv` / `csvCell` / `neutralizeCsvCell` 为纯函数（node 可直接单测），
 * `downloadCsv` 只负责 BOM + Blob + <a download> 的浏览器侧动作。
 */

/** Excel/WPS 会把以这些字符开头的单元格当公式执行（CSV injection）。 */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/** 公式注入中和：文本单元格前置单引号（W5-13 / W14-15）。
 *  只用于**字符串**单元格；数值列保持原样，避免把负数变成文本。 */
export function neutralizeCsvCell(text: string): string {
  return FORMULA_PREFIX.test(text) ? `'${text}` : text;
}

/** 单个 CSV 单元格：RFC4180 双引号 + 内部引号翻倍 + 公式注入中和。 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '""';
  let text: string;
  if (typeof value === "number") {
    // 非有限数值不写成 "NaN"/"Infinity" 文本单元格，按未知留空。
    text = Number.isFinite(value) ? String(value) : "";
  } else if (typeof value === "string") {
    text = neutralizeCsvCell(value);
  } else {
    text = neutralizeCsvCell(String(value));
  }
  return `"${text.replace(/"/g, '""')}"`;
}

/** 整张表转为 CSV 文本（不含 BOM；行分隔 \n）。 */
export function toCsv(rows: readonly (readonly unknown[])[]): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

export function downloadDataUrl(url: string | null, filename: string) {
  if (!url) return;
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
}

export function downloadCsv(rows: (string | number | null | undefined)[][], filename: string) {
  const text = toCsv(rows);
  const blob = new Blob(["\ufeff" + text], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
