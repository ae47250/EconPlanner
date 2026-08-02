"""Render the canonical EconMapper Economics report JSON as a PDF."""

import json
import sys
from html import escape
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import KeepTogether, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle


def paragraph(value, style):
    return Paragraph(escape(str(value if value is not None else "-")), style)


def main():
    if len(sys.argv) != 3:
        raise SystemExit("Usage: render-economics-pdf.py REPORT_JSON OUTPUT_PDF")

    report = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    output_path = Path(sys.argv[2])
    output_path.parent.mkdir(parents=True, exist_ok=True)

    styles = getSampleStyleSheet()
    title = ParagraphStyle("ReportTitle", parent=styles["Title"], fontName="Helvetica-Bold", fontSize=22, leading=26, textColor=colors.HexColor("#174d35"), alignment=TA_CENTER, spaceAfter=8)
    heading = ParagraphStyle("Heading", parent=styles["Heading2"], fontName="Helvetica-Bold", fontSize=13, leading=16, textColor=colors.HexColor("#174d35"), spaceBefore=12, spaceAfter=6)
    body = ParagraphStyle("Body", parent=styles["BodyText"], fontName="Helvetica", fontSize=9, leading=12)
    small = ParagraphStyle("Small", parent=body, fontSize=8, leading=10, textColor=colors.HexColor("#536257"))
    table_header = ParagraphStyle("TableHeader", parent=body, fontName="Helvetica-Bold", fontSize=7.5, leading=9, textColor=colors.white)

    story = [
        Paragraph("HANOVER COLLEGE", title),
        Paragraph("EconMapper - Economics Major Planning Report", heading),
        Paragraph(f"Student: {escape(report['student']['displayName'])} &nbsp;&nbsp; Prepared: {escape(report['preparedDate'])}", body),
        Paragraph(f"Planning horizon: {escape(report['planningHorizon'])} &nbsp;&nbsp; Standing: {escape(report['student']['academicStanding'])}", body),
        Spacer(1, 8),
        Paragraph(escape(report["inputSummary"]), body),
        Spacer(1, 8),
    ]

    remaining = report["remaining"]
    metrics = [
        [paragraph("Strict remaining", table_header), paragraph("Optimistic remaining", table_header), paragraph("After in-progress", table_header)],
        [paragraph(f"{remaining['strict']} units" if remaining["strict"] is not None else "Advisor check", body), paragraph(f"{remaining['optimistic']} units" if remaining["optimistic"] is not None else "Advisor check", body), paragraph(f"{remaining['projected']} units" if remaining["projected"] is not None else "Advisor check", body)],
    ]
    metric_table = Table(metrics, colWidths=[2.25 * inch] * 3)
    metric_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#174d35")),
        ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#c9d8cc")),
        ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#c9d8cc")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.extend([metric_table, Spacer(1, 8), Paragraph("Term plan", heading)])

    terms = report.get("terms", [])
    term_rows = [[paragraph("Term", table_header), paragraph("Planned courses", table_header)]]
    for term in terms:
        courses = term.get("courses", [])
        course_text = "<br/>".join(f"{escape(str(course.get('code', '')))} - {escape(str(course.get('title', '')))}" for course in courses) or "None placed"
        term_rows.append([paragraph(term.get("term", ""), body), Paragraph(course_text, body)])
    term_table = Table(term_rows, colWidths=[1.1 * inch, 5.65 * inch], repeatRows=1)
    term_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#174d35")),
        ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#c9d8cc")),
        ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#c9d8cc")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.extend([term_table, Paragraph("S sections from the source schedule are displayed as May Term.", small), Paragraph("Requirement assignments", heading)])

    requirement_rows = [[paragraph(label, table_header) for label in ["Requirement", "Strict", "Optimistic", "In progress", "Evidence"]]]
    for item in report.get("requirements", []):
        requirement_rows.append([paragraph(item.get("label"), body), paragraph(item.get("strict") or "Remaining", body), paragraph(item.get("optimistic") or "Remaining", body), paragraph(item.get("projected") or "Remaining", body), paragraph(item.get("evidence") or "-", body)])
    requirement_table = Table(requirement_rows, colWidths=[1.7 * inch, 1.1 * inch, 1.1 * inch, 1.1 * inch, 1.75 * inch], repeatRows=1)
    requirement_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#174d35")),
        ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#c9d8cc")),
        ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#c9d8cc")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story.append(requirement_table)

    checks = [
        *(f"{item.get('label', item.get('requirementId', 'Requirement'))}: {item.get('reason', 'Remaining')}" for item in report.get("unresolved", [])),
        *(f"{item.get('course', 'Advisor check')}: {item.get('reason', '')}" for item in report.get("advisorChecks", [])),
    ]
    if checks:
        check_story = [Paragraph("Advisor checks", heading)]
        check_story.extend(Paragraph(f"- {escape(check)}", body) for check in checks)
        story.append(KeepTogether(check_story))
    story.append(Spacer(1, 10))
    story.append(Paragraph("Confirm requirements, substitutions, prerequisites, and availability with Hanover Academic Advising.", small))

    def footer(canvas, document):
        canvas.saveState()
        canvas.setFont("Helvetica", 8)
        canvas.setFillColor(colors.HexColor("#536257"))
        canvas.drawString(0.65 * inch, 0.4 * inch, "Hanover College EconMapper")
        canvas.drawRightString(7.85 * inch, 0.4 * inch, f"Page {document.page}")
        canvas.restoreState()

    document = SimpleDocTemplate(str(output_path), pagesize=letter, rightMargin=0.65 * inch, leftMargin=0.65 * inch, topMargin=0.6 * inch, bottomMargin=0.65 * inch, title="Hanover College EconMapper Economics Report")
    document.build(story, onFirstPage=footer, onLaterPages=footer)


if __name__ == "__main__":
    main()
