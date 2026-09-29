"""Legacy ReportLab utility; report:economics uses the shared HTML/Chromium layout."""

import json
import re
import sys
from html import escape
from pathlib import Path

from reportlab.graphics.shapes import Circle, Drawing, Line, Path as ShapePath, String
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

    selected = report.get("selectedPlan") or {}
    target = (selected.get("planningContext") or {}).get("expectedGraduationTerm")
    if target:
        story.append(Paragraph(f"Expected graduation: {escape(target)}", body))
    conditions = report.get("planConditions", [])
    if conditions:
        story.append(Paragraph("Actions and conditions", heading))
        for item in conditions:
            story.append(Paragraph(f"- {escape(item['message'])}", body))
    terms = report.get("terms", [])
    term_rows = [[paragraph("Term", table_header), paragraph("Planned courses", table_header)]]
    for term in terms:
        courses = term.get("courses", [])
        course_lines = []
        for course in courses:
            line = f"{escape(str(course.get('displayLabel') or course.get('code', '')))} - {escape(str(course.get('title', '')))}"
            if course.get("availabilityDisplayApplicable"):
                line += "<br/>" + escape((course.get("seatStatusDisplay") or {}).get("label", "Current seat status unverified"))
            markers = list(course.get("planningMarkers") or [])
            if course.get("approvalRequired") and "Approval required" not in markers:
                markers.append("Approval required")
            for marker in markers:
                line += "<br/>" + escape(marker)
            course_lines.append(line)
        course_text = "<br/>".join(course_lines) or "None placed"
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
    story.extend([Paragraph("Term plan", heading), term_table])
    story.append(Paragraph("Major requirements checklist", heading))

    checklist = report.get("majorRequirementsChecklist") or {"rows": []}
    requirement_rows = [[paragraph(label, table_header) for label in ["Requirement", "Course / term", "Status"]]]
    status_colors = {"completed": "#176333", "in_progress": "#174d7a", "planned": "#485365", "still_needed": "#76510b"}
    status_backgrounds = {"completed": "#e9f6ed", "in_progress": "#e4f2ff", "planned": "#eef0f3", "still_needed": "#fff2d6"}
    for item in checklist["rows"]:
        if item["status"] == "still_needed":
            continue
        tone = status_colors[item["status"]]
        status_text = f'<font color="{tone}">{escape(item["statusLabel"])}</font>'
        markers = "<br/>".join(escape(marker) for marker in item.get("markers", []))
        if markers:
            status_text += f'<br/><font color="#76510b">{markers}</font>'
        icon = Drawing(12, 12)
        ink = colors.HexColor(tone)
        if item["status"] == "completed":
            icon.add(Line(1, 5, 4, 2, strokeColor=ink, strokeWidth=1.5))
            icon.add(Line(4, 2, 11, 10, strokeColor=ink, strokeWidth=1.5))
        elif item["status"] in ["in_progress", "planned"]:
            icon.add(Circle(6, 6, 4.5, strokeColor=ink, fillColor=None))
            if item["status"] == "in_progress":
                half = ShapePath(fillColor=ink, strokeColor=None)
                half.moveTo(6, 1.5)
                half.curveTo(0, 1.5, 0, 10.5, 6, 10.5)
                half.close()
                icon.add(half)
        else:
            icon.add(String(5, 2, "!", fontName="Helvetica-Bold", fontSize=13, fillColor=ink))
        status_cell = Table([[icon, Paragraph(status_text, body)]], colWidths=[15, 100])
        status_cell.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0)]))
        status_cell.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), colors.HexColor(status_backgrounds[item["status"]]))]))
        assignment = escape(item["courseTerm"])
        if len(item.get("alternatives", [])) > 1:
            assignment += "<br/>Requirement options: " + escape(" / ".join(item["alternatives"]))
        requirement_rows.append([paragraph(item["label"], body), Paragraph(assignment, body), status_cell])
    requirement_table = Table(requirement_rows, colWidths=[1.8 * inch, 3.15 * inch, 1.8 * inch], repeatRows=1)
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
    story.extend([requirement_table, Paragraph(escape(checklist.get("note", "")), small)])
    if checklist.get("unmetRequirements"):
        story.append(Paragraph("Incomplete candidate — unmet requirements", heading))
        story.append(Paragraph("No qualifying assignment is recorded for the requirements below. This alone does not establish that no viable plan exists.", body))
        for item in checklist["unmetRequirements"]:
            story.append(paragraph(item["label"] + ": " + item["courseTerm"], body))

    def note_text(value):
        return re.sub(r"\bECO \d{3}\b", lambda match: f"<b>{match.group()}</b>", escape(str(value or "")))

    notes = report.get("planNotes", [])
    if notes:
        story.append(Paragraph("Plan Notes", heading))
        for note in notes:
            note_story = [Paragraph(escape(note["title"]), heading)]
            if note.get("description"):
                note_story.append(Paragraph(escape(note["description"]), body))
            for item in note["items"]:
                label = f"<b>{escape(item['code'])}</b> " if item.get("code") else ""
                if item.get("label"):
                    label += f"<b>{escape(item['label'])}</b>: "
                lines = item.get("lines")
                content = "<br/>".join(note_text(line) for line in lines) if lines else note_text(item.get("text"))
                note_story.append(Paragraph(f"- {label}{content}", body))
            if note.get("caveat"):
                note_story.append(Paragraph(escape(note["caveat"]), small))
            story.append(KeepTogether(note_story))

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
