export type ReportSection = {
  title: string;
  lines: string[];
};

export function renderReportSection(section: ReportSection): string {
  return (Array.isArray(section.lines) ? section.lines : [])
    .map((line) => String(line || "").trimEnd())
    .filter(Boolean)
    .join("\n");
}
