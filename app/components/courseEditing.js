"use client";

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { isUnpublishedScheduleCondition, studentFriendlyUnavailableAdvice, studentFriendlyUnavailableReason, studentFriendlyMoveCondition, studentFriendlyMoveDetails, studentFriendlyMoveNextStep, studentTermLabel } from "../../lib/planning/student-language.js";
import { planCourseIdentity, compactPlanCourse } from "../plannerShared.js";

const CourseMenuContext = createContext(null);

function useEditorPosition(open, anchorRef, placement = "left") {
  const [position, setPosition] = useState({});
  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return;
    const place = () => {
      const rect = anchorRef.current.getBoundingClientRect();
      const width = Math.min(320, window.innerWidth - 24);
      const left = placement === "button"
        ? Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))
        : rect.left >= width + 20
          ? rect.left - width - 8
          : Math.max(12, Math.min(rect.right + 8, window.innerWidth - width - 12));
      const top = Math.max(12, Math.min(rect.top, window.innerHeight - 280));
      setPosition({ position: "fixed", left, top, width,
        maxHeight: Math.min(320, window.innerHeight - top - 12), overflowY: "auto", margin: 0, zIndex: 20 });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, anchorRef, placement]);
  return position;
}

function ExtraCoursePicker({ plan, onEdit, busy }) {
  const planId = plan.id;
  const [termId, setTermId] = useState("");
  const term = plan.terms.find(item => item.slotId === termId);
  const menu = useContext(CourseMenuContext);
  const menuId = `${planId}:add`;
  const open = menu.openId === menuId;
  const trigger = useRef(null);
  const editorPosition = useEditorPosition(open, trigger, "button");
  const panel = useRef(null);
  const container = useRef(null);
  const [selected, setSelected] = useState(null);
  const close = () => { menu.setOpenId(current => current === menuId ? null : current); setSelected(null); setTermId(""); };
  useEffect(() => {
    if (!open) { setSelected(null); return; }
    const dismiss = event => { if (!event.composedPath().includes(container.current)) close(); };
    document.addEventListener("click", dismiss);
    return () => document.removeEventListener("click", dismiss);
  }, [open]);
  const add = async (item, control) => {
    if (await onEdit({type:"add-extra",planId,toTermId:term.slotId,course:item.course},control)) close();
  };
  const usable = (term?.extraCourseOptions || []).filter(item => ["ALLOWED", "CONDITIONAL"].includes(item.status));
  const blocked = (term?.extraCourseOptions || []).find(item => !["ALLOWED", "CONDITIONAL"].includes(item.status));
  return <div className="plan-course-actions extra-course-picker" ref={container} onKeyDown={event => {
    if (event.key === "Escape") { event.stopPropagation(); close(); trigger.current?.focus(); }
  }}>
    <button type="button" ref={trigger} aria-expanded={open} aria-label={`Add Econ course: ${plan.label}`} disabled={busy}
      onClick={() => menu.setOpenId(open ? null : menuId)}>Add Econ course</button>
    <div hidden={!open} ref={panel} style={editorPosition} className="course-change-panel" role="region" aria-label={`Add Econ course options: ${plan.label}`}>
      <button type="button" className="close-course-options" onClick={close}>Close ×</button>
      <strong className="change-menu-heading">{selected ? "Add Extra course" : "Add Economics course"}</strong>
      {!term ? <>
        <span>Which term?</span>
        {plan.terms.map(item => <button type="button" className="change-menu-option" key={item.slotId} onClick={() => setTermId(item.slotId)}>{studentTermLabel(item.term)}</button>)}
      </> : <>
      <button type="button" className="change-menu-option" onClick={() => { setTermId(""); setSelected(null); }}>← {studentTermLabel(term.term)}</button>
      {selected ? <>
        <strong>{selected.course === "ECO elective" ? "200+ Economics elective" : selected.course}</strong>
        <p className="change-confirm-warning">{studentFriendlyMoveCondition(selected, selected.course, menu.policyMessages)}</p>
        <div className="change-confirm-actions"><button type="button" disabled={busy} onClick={event => add(selected,event.currentTarget)}>Add course</button><button type="button" onClick={close}>Cancel</button></div>
      </> : <>
        {usable.length ? <section aria-label={usable[0].evidence === "published" ? "Published for this term" : "Future elective"}>
          <strong className="change-menu-heading">{usable[0].evidence === "published" ? "Published for this term" : "Schedule not yet published"}</strong>
          {usable.map(item => <button type="button" className="change-menu-option" key={item.course} disabled={busy} onClick={event => item.status === "CONDITIONAL" ? setSelected(item) : add(item,event.currentTarget)}>
            <span>{item.course === "ECO elective" ? "Add a 200+ elective" : item.course}</span><small>{item.title}</small>
          </button>)}
        </section> : <p>{blocked ? studentFriendlyUnavailableReason(blocked, menu.policyMessages) : "No eligible extra course is available in this term."} {blocked && studentFriendlyMoveNextStep(blocked)}</p>}
        {term.extraCourseHistory?.length > 0 && <details><summary>Previously scheduled — not confirmed</summary>
          <ul>{term.extraCourseHistory.map(item => <li key={item.course}>{item.course} · {item.title}</li>)}</ul>
        </details>}
      </>}
      </>}
    </div>
  </div>;
}

function CourseChange({ course, termId, planId, onEdit, busy, feedback, onUndo, canUndo, compact = false }) {
  const menu = useContext(CourseMenuContext);
  const menuId = `${planId}:${planCourseIdentity(course)}`;
  const open = menu.openId === menuId;
  const setOpen = value => menu.setOpenId(current => value ? menuId : current === menuId ? null : current);
  const [choice, setChoice] = useState("");
  const trigger = useRef(null);
  const editorPosition = useEditorPosition(open, trigger);
  const container = useRef(null);
  const panel = useRef(null);
  const dismissTimer = useRef(null);
  useEffect(() => () => clearTimeout(dismissTimer.current), []);
  useEffect(() => {
    if (!open) return;
    const dismiss = event => {
      if (!event.composedPath().includes(container.current)) { setOpen(false); setChoice(""); }
    };
    document.addEventListener("click", dismiss);
    return () => document.removeEventListener("click", dismiss);
  }, [open]);
  useEffect(() => { if (!open) setChoice(""); }, [open]);
  const moves = (course.moveDestinationOptions || []).filter(item => item.status !== "CURRENT")
    .map(item => ({ ...item, key: `move:${item.id}`, edit: { type: "move", toTermId: item.id },
      action: `Keep ${compactPlanCourse(course)} — ${item.label}` }));
  const replacements = (course.replacementDestinationOptions || []).map(item => ({ ...item,
    key: `replace:${item.id}`, edit: { type: "replace-move", toTermId: item.toTermId, replacementCourse: item.course },
    action: item.course === "ECO elective"
      ? `Move as a 200+ elective — choose the course later: ${item.label}`
      : `Replace with ${item.course} — ${item.label}` }));
  const all = [...moves, ...replacements];
  const usable = all.filter(item => ["ALLOWED", "CONDITIONAL"].includes(item.status));
  const guidance = [...new Set(all.filter(item => !["ALLOWED", "CONDITIONAL"].includes(item.status))
    .map(item => studentFriendlyUnavailableAdvice({ ...item, movingCourse: course.course }, menu.policyMessages))
    .filter(advice => advice.suggestsFix).map(advice => advice.message))].slice(0, 2);
  const optionGroups = usable.reduce((groups, item) => {
    const label = item.edit.type === "move" ? "Move to"
      : item.edit.replacementCourse === "ECO elective" ? "Move as a 200+ elective"
        : studentTermLabel(item.label).replace(/^(\d{4})\/(\d{4}) (.*)$/, (_, start, end, season) => `${season} ${season === "Fall" ? start : end}`);
    const group = groups.find(group => group.label === label);
    if (group) group.items.push(item);
    else groups.push({ label, items: [item] });
    return groups;
  }, []);
  const selected = usable.find(item => item.key === choice);
  useEffect(() => {
    menu.setConfirmingId(current => open && selected ? menuId : current === menuId ? null : current);
  }, [open, selected, menuId]);
  useLayoutEffect(() => {
    if (open && selected) {
      clearTimeout(dismissTimer.current);
      panel.current?.querySelector(".change-confirm-actions button")?.focus({ preventScroll: true });
    }
  }, [open, choice]);
  const close = () => { setOpen(false); setChoice(""); trigger.current?.focus(); };
  const apply = async (item, control) => {
    const saved = await onEdit({ ...item.edit, planId, fromTermId: termId, courseId: planCourseIdentity(course) }, control);
    if (saved) close();
  };
  return <div className="plan-course-actions" ref={container}
    data-current-term={`move:${termId}`} aria-label={`Changes for ${compactPlanCourse(course)}`}
    onPointerEnter={() => clearTimeout(dismissTimer.current)}
    onPointerLeave={event => {
      if (event.pointerType !== "mouse" || busy || selected) return;
      dismissTimer.current = setTimeout(() => { setOpen(false); setChoice(""); }, 350);
    }}
    onKeyDown={event => {
      if (event.key === "Escape" && !busy) { event.stopPropagation(); close(); }
      if (event.key === "ArrowDown" && event.target === trigger.current) {
        event.preventDefault(); setOpen(true);
        requestAnimationFrame(() => container.current?.querySelector("[data-change-choice]")?.focus());
      }
    }}>
    <button type="button" ref={trigger} data-course-edit-id={`${planId}:${planCourseIdentity(course)}:change`}
      aria-label={`Change ${compactPlanCourse(course)}`} aria-expanded={open}
      disabled={busy} onClick={() => { setOpen(true); setChoice(""); }}>{compact ? compactPlanCourse(course) : "Change"} ▾</button>
    <div hidden={!open} ref={panel} style={editorPosition} className="course-change-panel" role="region" aria-label={`Change ${compactPlanCourse(course)} options`}>
      <div className="course-editor-title"><strong>{compactPlanCourse(course)}</strong><button type="button" className="close-course-options" onClick={close} aria-label="Close course options">Close ×</button></div>
      {!selected && (course.course !== "ECO 461" || optionGroups.length > 0) && (optionGroups.length ? optionGroups.map((group, groupIndex) => <section className="change-option-group" aria-label={group.label} key={group.label}>
        {group.items[0].edit.type === "replace-move" && group.items[0].edit.replacementCourse !== "ECO elective" && !optionGroups.slice(0, groupIndex).some(item => item.items[0].edit.type === "replace-move" && item.items[0].edit.replacementCourse !== "ECO elective") && <strong className="change-menu-heading">Take a different course</strong>}
        <strong className="change-menu-heading">{group.label}</strong>
        {group.items.map(item => <button type="button" className="change-menu-option"
          data-change-choice={item.key} data-change-status={item.status} key={item.key} disabled={busy}
          onClick={event => {
            if (item.status === "CONDITIONAL" || item.edit.type === "replace-move") { clearTimeout(dismissTimer.current); setChoice(item.key); }
            else apply(item, event.currentTarget);
          }}>
          <span>{item.edit.type === "replace-move" && item.edit.replacementCourse !== "ECO elective" ? item.edit.replacementCourse : studentTermLabel(item.label)}</span>
          {item.status === "CONDITIONAL" && !isUnpublishedScheduleCondition(item) && <small>{studentFriendlyMoveCondition(item, course.course, menu.policyMessages)}</small>}
        </button>)}
        {group.items.some(isUnpublishedScheduleCondition) && <small className="change-confirm-warning">{studentFriendlyMoveCondition(group.items.find(isUnpublishedScheduleCondition), course.course, menu.policyMessages)}</small>}
      </section>) : <p>{all.length ? studentFriendlyUnavailableReason({ ...all[0], movingCourse: course.course }, menu.policyMessages) : "No other move is available right now."}</p>)}
      {selected && <>
        <strong className="change-confirm-title">{selected.edit.type === "move" ? `Move ${compactPlanCourse(course)}` : `Replace with ${selected.edit.replacementCourse === "ECO elective" ? "a 200+ elective" : selected.edit.replacementCourse}`}</strong>
        <span className="change-confirm-term">{studentTermLabel(selected.label)}</span>
        {selected.edit.replacementCourse === "ECO elective" && <p>Choose the exact course later.</p>}
        <p className="change-confirm-warning">{studentFriendlyMoveCondition(selected, course.course, menu.policyMessages)}</p>
        <details className="course-reason-details"><summary>Full check details</summary><p>{studentFriendlyMoveDetails(selected)}</p>
        </details>
        <div className="change-confirm-actions">
          <button type="button" aria-label="Apply change" disabled={busy} onClick={event => apply(selected, event.currentTarget)}>{busy ? "Checking…" : selected.edit.type === "move" ? "Move" : "Replace"}</button>
          <button type="button" disabled={busy} onClick={close}>Cancel</button>
        </div>
      </>}
      {!selected && usable.length === 0 && course.course !== "ECO 461" && guidance.slice(0, 1).map(reason => <p className="change-menu-guidance" key={reason}>{reason}</p>)}
      {!selected && course.extra === true && <button type="button" disabled={busy} onClick={async event => {
        if (await onEdit({type:"remove-extra",planId,fromTermId:termId,courseId:planCourseIdentity(course)},event.currentTarget)) close();
      }}>Remove Extra course</button>}

    </div>
    {feedback && <p className={`plan-course-edit-feedback${feedback.failed ? " is-error" : ""}`} role={feedback.failed ? "alert" : "status"}>{feedback.message}</p>}
    {canUndo && <button type="button" disabled={busy} onClick={onUndo}>Undo last plan edit</button>}
  </div>;
}

function CourseDragHandle({ course, termId, planId, compact = false, busy, setPendingDrop, setDropMessage, setDraggedCourse, applyDrop }) {
  const { policyMessages } = useContext(CourseMenuContext);
  const pointerDragRef = useRef(null);
  useEffect(() => {
    const cancel = event => {
      if (event.key === "Escape" && pointerDragRef.current) {
        pointerDragRef.current = null; setDraggedCourse(null); setDropMessage("Move cancelled.");
      }
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [setDraggedCourse, setDropMessage]);
  return <span
                                className="course-drag-handle"
                                title={`Drag ${compactPlanCourse(course)} to another term`}
                                aria-hidden="true"
                                onPointerDown={event => {
                                  if (busy || event.button !== 0) return;
                                  event.preventDefault();
                                  event.currentTarget.setPointerCapture(event.pointerId);
                                  pointerDragRef.current = { x: event.clientX, y: event.clientY, active: false,
                                    planId: planId, fromTermId: termId, course,
                                    trigger: event.currentTarget.parentElement.querySelector("[data-course-edit-id]") };
                                }}
                                onPointerMove={event => {
                                  const moving = pointerDragRef.current;
                                  if (!moving) return;
                                  if (!moving.active && Math.hypot(event.clientX - moving.x, event.clientY - moving.y) > 5) {
                                    moving.active = true;
                                    setPendingDrop(null);
                                    setDropMessage(`Moving ${compactPlanCourse(course)}. Release over a destination term.`);
                                    setDraggedCourse(moving);
                                  }
                                  if (moving.active) {
                                    if (event.clientY < 80) window.scrollBy(0, -20);
                                    else if (event.clientY > window.innerHeight - 80) window.scrollBy(0, 20);
                                  }
                                }}
                                onPointerUp={event => {
                                  const moving = pointerDragRef.current;
                                  pointerDragRef.current = null;
                                  setDraggedCourse(null);
                                  setDropMessage("");
                                  if (!moving?.active || busy || moving.planId !== planId) return;
                                  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-term-id]");
                                  const destination = moving.course.moveDestinationOptions?.find(option => option.id === target?.dataset.termId);
                                  if (!target || target.dataset.planScope !== planId || destination?.status === "CURRENT") return;
                                  if (!["ALLOWED", "CONDITIONAL"].includes(destination?.status)) {
                                    setDropMessage(studentFriendlyUnavailableReason(destination, policyMessages));
                                    return;
                                  }
                                  const drop = { ...moving, destination, anchorElement: target };
                                  if (destination.status === "CONDITIONAL") setPendingDrop(drop);
                                  else applyDrop(drop, moving.trigger);
                                }}
                                onPointerCancel={() => { pointerDragRef.current = null; setDraggedCourse(null); setDropMessage(""); }}
                              >{compact ? "⠿" : "⠿ Drag"}</span>;
}

function MoveConfirmation({ drop, onApply, onCancel, busy }) {
  const { policyMessages } = useContext(CourseMenuContext);
  const panel = useRef(null);
  const [position, setPosition] = useState({});
  useLayoutEffect(() => {
    const place = () => {
      const margin = 12;
      const width = Math.min(340, window.innerWidth - margin * 2);
      const height = panel.current?.getBoundingClientRect().height || 200;
      const anchor = drop.anchorElement?.getBoundingClientRect();
      const rightFits = anchor && anchor.right + width + margin <= window.innerWidth;
      const leftFits = anchor && anchor.left - width - margin >= margin;
      const left = rightFits ? anchor.right + 6 : leftFits ? anchor.left - width - 6 : anchor?.left || margin;
      const top = rightFits || leftFits ? anchor.top : anchor?.bottom || margin;
      setPosition({ width,
        left: Math.max(margin, Math.min(left, window.innerWidth - width - margin)),
        top: Math.max(margin, Math.min(top, window.innerHeight - height - margin))
      });
    };
    place();
    panel.current?.focus({ preventScroll: true });
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [drop]);
  return <div className="drop-confirmation drop-confirmation-popover" role="region"
    aria-label="Review move conditions" ref={panel} style={position} tabIndex={-1}
    onKeyDown={event => { if (event.key === "Escape" && !busy) { event.stopPropagation(); onCancel(); } }}>
    <strong>Move {compactPlanCourse(drop.course)} to {studentTermLabel(drop.destination.label)}?</strong>
    <p>{studentFriendlyMoveCondition(drop.destination, drop.course.course, policyMessages)}</p>
    <details><summary>Check details</summary><p>{drop.destination.message}</p></details>
    <div className="drop-confirmation-actions">
      <button type="button" disabled={busy} onClick={event => onApply(drop, event.currentTarget)}>Apply move</button>
      <button type="button" disabled={busy} onClick={onCancel}>Cancel move</button>
    </div>
  </div>;
}

export { CourseMenuContext, useEditorPosition, ExtraCoursePicker, CourseChange, CourseDragHandle, MoveConfirmation };
