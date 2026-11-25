import css from "styled-jsx/css";

export const comparisonStyles = css.global`
        body {
          margin: 0;
          background: #f5f5f7;
          color: #1d1d1f;
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif;
        }
        button, input, select { font-family: inherit; }
        .comparison-page {
          box-sizing: border-box;
          min-height: 100vh;
          overflow-wrap: anywhere;
          animation: comparison-enter .28s ease-out both;
        }
        .comparison-page * { box-sizing: border-box; }
        .comparison-page.is-exiting { animation: comparison-exit .24s ease-in both; }
        @keyframes comparison-enter {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes comparison-exit {
          from { opacity: 1; }
          to { opacity: 0; }
        }
        .comparison-topbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 1rem;
          padding: 1rem 2rem;
          border-bottom: 1px solid #e5e5ea;
          background: #fff;
          box-shadow: 0 1px 5px rgba(25, 30, 45, .035);
        }
        .comparison-brand {
          display: flex;
          align-items: flex-start;
          flex-direction: column;
          gap: .35rem;
          color: #4b2e83;
          font-size: 25px;
          font-weight: 700;
          letter-spacing: -.03em;
        }
        .comparison-brand-logo { display: block; width: 168px; height: auto; }
        .comparison-student {
          display: flex;
          align-items: center;
          gap: .45rem;
          margin-left: auto;
          color: #2f1c57;
          font-size: 15px;
        }
        .comparison-student strong { font-weight: 700; }
        .comparison-actions {
          display: flex;
          align-items: center;
          gap: .65rem;
          margin-left: 1.25rem;
        }
        .edit-courses-button,
        .regenerate-plans-button {
          width: auto;
          min-height: 44px;
          margin: 0;
          padding: .65rem 1rem;
          border: 1px solid #85709f;
          border-radius: .7rem;
          background: #fff;
          color: #2f1c57;
          font-size: 14px;
          font-weight: 700;
          cursor: pointer;
        }
        .edit-courses-button:hover,
        .regenerate-plans-button:hover { background: #f4f1f8; }
        .comparison-page button:focus-visible,
        .comparison-page input:focus-visible,
        .comparison-page select:focus-visible,
        .comparison-page summary:focus-visible {
          outline: 3px solid #8ab4f8;
          outline-offset: 2px;
        }
        .regenerate-plans-button:disabled { cursor: wait; opacity: .65; }
        .pdf-download-status { color: #33425d; font-size: 12px; }
        .comparison-content {
          width: min(1460px, calc(100% - 3rem));
          margin: 0 auto;
          padding: 1.15rem 0 3rem;
        }
        .comparison-back {
          width: auto;
          min-height: 0;
          margin: 0;
          padding: .25rem 0;
          border: 0;
          background: transparent;
          color: #4b2e83;
          font-size: 14px;
          cursor: pointer;
        }
        .comparison-back:hover { text-decoration: underline; }
        .comparison-course-status {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: .25rem;
          margin: .65rem 0 .9rem;
          padding: .65rem .8rem;
          border: 1px solid #cbd5e1;
          border-radius: .5rem;
          background: rgba(255, 255, 255, .82);
          color: #33425d;
          font-size: 12px;
        }
        .comparison-course-status p { margin: 0; }
        .comparison-course-status strong { color: #2f1c57; }
        .comparison-course-status span { display: block; margin-top: .2rem; font-size: 14px; }
        .result-status-value { font-weight: 700; }
        .result-status-reason { color: #52627a; font-size: 12px !important; line-height: 1.4; }
        .comparison-heading-row {
          display: flex;
          align-items: flex-end;
          justify-content: space-between;
          gap: 1.5rem;
          margin: .55rem 0 1rem;
        }
        .comparison-heading-row h1 {
          margin: 0;
          color: #2f1c57;
          font-size: clamp(29px, 3vw, 42px);
          line-height: 1.05;
          letter-spacing: -.035em;
        }
        .comparison-heading-row p {
          margin: .45rem 0 0;
          color: #53627a;
          font-size: 15px;
        }
        @media (max-width: 900px) {
          .comparison-heading-row { align-items: flex-start; flex-wrap: wrap; gap: .6rem; }
          .comparison-heading-row > div { min-width: 0; flex: 1 1 100%; }
          .difference-toggle { margin-left: auto; }
        }
        .difference-toggle {
          display: flex;
          align-items: center;
          gap: .6rem;
          flex: 0 0 auto;
          color: #2f1c57;
          font-size: 14px;
          cursor: pointer;
        }
        .difference-toggle input {
          width: 2.7rem;
          height: 1.45rem;
          accent-color: #4b2e83;
          cursor: pointer;
        }
        .comparison-difference-key {
          margin: -.35rem 0 1rem;
          padding: .65rem .8rem;
          border: 1px solid #b8cdf4;
          border-radius: .5rem;
          background: #f3f7ff;
          color: #33425d;
          font-size: 13px;
        }
        .comparison-difference-key strong { color: #4169a6; }
        .course-editor-title { display: flex; justify-content: space-between; align-items: center; gap: .25rem; font-size: 13px; }
        .comparison-plan-details { margin: .6rem 0; text-align: left; }
        .comparison-plan-details .major-checklist { margin: .4rem 0; padding: 0; border: 0; box-shadow: none; }
        .comparison-plan-details .comparison-disclosure { margin: .25rem 0; }
        .comparison-plan-details .comparison-disclosure > summary { padding: .5rem; font-size: 13px; }
        .comparison-plan-details .plan-notes { margin: 0; padding: .5rem; font-size: 13px; }
        .comparison-page .plan-edit-instructions { margin: .7rem 0 0; padding: .65rem .85rem; border-left: 3px solid #8065b0; background: #eee9f6; border-radius: 0 .4rem .4rem 0; color: #30234c; }
        .comparison-page .plan-edit-instructions strong { display: block; font-size: 17px; line-height: 1.4; }
        .comparison-page .plan-edit-instructions span { display: block; margin-top: .2rem; font-size: 13px; color: #53617a; }
        .comparison-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(min(100%, 360px), 1fr));
          gap: 1rem;
          align-items: stretch;
        }
        .comparison-plan-card {
          display: flex;
          min-width: 0;
          flex-direction: column;
          overflow: visible;
          border: 1px solid #d9d9df;
          border-radius: 1rem;
          background: #fff;
          box-shadow: 0 .4rem 1.25rem rgba(25, 30, 45, .045);
        }
        .comparison-plan-card.is-selected {
          border-color: #9b86bd;
          box-shadow: 0 .6rem 1.5rem rgba(75, 46, 131, .1);
        }
        .comparison-plan-summary {
          min-height: 8rem;
          padding: 1.15rem 1.15rem .9rem;
          text-align: center;
        }
        .plan-title-row {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: .6rem;
          flex-wrap: wrap;
        }
        .comparison-plan-summary h2 {
          margin: 0;
          color: #2f1c57;
          font-size: 25px;
          line-height: 1.1;
        }
        .comparison-plan-summary p {
          max-width: 26rem;
          margin: .65rem auto 0;
          color: #41506a;
          font-size: 15px;
          line-height: 1.5;
        }
        .comparison-plan-summary .plan-feasibility-value {
          margin-top: .45rem;
          font-size: 13px;
          font-weight: 650;
        }
        .early-plan-status {
          display: inline-block;
          padding: .35rem .55rem;
          border: 1px solid #c5b5df;
          border-radius: 999px;
          background: #f7f4fb;
          color: #4f2d7f;
          font-size: 12px;
          font-weight: 650;
        }
        .early-plan-graduation-dates {
          max-width: 24rem;
          margin: .75rem auto 0;
          text-align: left;
        }
        .early-plan-graduation-dates > div { grid-template-columns: minmax(7rem, 1fr) auto; }
        .plan-strategy-badge {
          padding: .35rem .55rem;
          border: 1px solid #9dc7ff;
          border-radius: .4rem;
          background: #f3f8ff;
          color: #4b2e83;
          font-size: 12px;
        }
        .comparison-plan-card:nth-child(3) .plan-strategy-badge {
          border-color: #94cfbd;
          background: #f1fbf7;
          color: #087257;
        }
        .compact-schedule {
          width: calc(100% - 1.4rem);
          margin: 0 .7rem .85rem;
          border-collapse: collapse;
          table-layout: fixed;
          font-size: 14px;
        }
        .compact-schedule th,
        .compact-schedule td {
          padding: .3rem .4rem;
          border: 1px solid #d9dce2;
          text-align: left;
          vertical-align: top;
        }
        .compact-schedule th {
          background: #f2f5f9;
          color: #46536a;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: .035em;
        }
        .compact-schedule th:first-child { width: 6.4rem; }
        .compact-schedule th:nth-child(2) { width: 5.2rem; }
        .compact-schedule tbody tr[data-year-start="true"]:not(:first-child) > td { border-top: 2px solid #b7a8cf; }
        .compact-schedule td { font-size: 13px; }
        .compact-schedule td[rowspan] { white-space: nowrap; }
        .compact-schedule td.comparison-academic-year { color: #26364d; font-weight: 700; }
        .compact-schedule td:last-child {
          color: #111d36;
          font-weight: 700;
          line-height: 1.35;
          overflow-wrap: normal;
          word-break: normal;
        }
        .comparison-shared-course {
          color: #4169a6;
          font-weight: 500;
        }
        .comparison-empty-term {
          color: #68758a;
          font-weight: 500;
        }
        .plan-validation {
          margin: auto .9rem .7rem;
          color: #087257;
          font-size: 11px;
          font-weight: 700;
          text-align: center;
        }
        .plan-validation.is-invalid { color: #a52a1f; }
        .comparison-page .course-drag-handle { display: inline-block; padding: .35rem .55rem; margin-bottom: .4rem; border: 1px solid #c4b5df; border-radius: .4rem; color: #49317c; background: #f7f3ff; cursor: grab; user-select: none; touch-action: none; font-size: .8rem; }
        .comparison-page .course-drag-handle:active { cursor: grabbing; }
        .comparison-page .drop-confirmation { padding: 1rem; margin-bottom: 1rem; border: 1px solid #946200; border-radius: .75rem; background: #fffbeb; }
        .comparison-page .drop-confirmation button { margin: .5rem .5rem 0 0; }
        .comparison-page .compact-schedule tr.drop-pending { outline: 2px solid #946200; background: #fffbeb; }
        .comparison-page .drop-confirmation-popover { position: fixed; z-index: 50; margin: 0; padding: .75rem; max-height: calc(100vh - 24px); overflow-y: auto; box-shadow: 0 8px 28px #24174330; font-size: 14px; line-height: 1.4; }
        .comparison-page .drop-confirmation-popover p { margin: .5rem 0; font-size: 13px; overflow-wrap: anywhere; }
        .comparison-page .drop-confirmation-popover details { margin: .4rem 0; font-size: 12px; }
        .comparison-page .drop-confirmation-actions { display: flex; gap: .5rem; }
        .comparison-page .drop-confirmation-actions button { margin: .25rem 0 0; padding: .4rem .65rem; min-height: 36px; font-size: 13px; }
        .comparison-page .drop-confirmation-actions button:first-child { background: #49317c; border-color: #49317c; }
        .comparison-page .drop-confirmation-actions button:last-child { background: white; color: #49317c; border-color: #b8a7d0; }
        .comparison-page .plan-course-availability.is-open { color: #167c32; font-weight: 700; }
        .comparison-page .plan-course-availability.is-full { color: #b42318; font-weight: 700; }
        .comparison-page .plan-course-availability.is-unavailable,
        .comparison-page .plan-course-availability.is-unverified { color: #53627a; }
        .major-checklist { margin: 1rem 0; padding: 0; border: 0; background: transparent; }
        .major-checklist h2,.upfront-conditions h2 { margin: 0 0 .6rem; font-size: 19px; }
        .major-checklist table { width: 100%; border-collapse: collapse; table-layout: fixed; }
        .major-checklist th,.major-checklist td { padding: .65rem .5rem; text-align: left; vertical-align: top; border-bottom: 1px solid #dde3eb; font-size: 14px; overflow-wrap: anywhere; }
        .major-checklist thead { background: #eef3f8; }
        .major-checklist th:first-child { width: 31%; }
        .major-checklist th:nth-child(2) { width: 45%; }
        .major-checklist th:last-child { width: 24%; }
        .checklist-status { display: inline-block; padding: .2rem .35rem; border-radius: 5px; font-weight: 700; }
        .checklist-symbol { font-size: 20px; line-height: 1; vertical-align: middle; }
        .checklist-legend { display: flex; gap: .6rem; flex-wrap: wrap; margin-top: .7rem; font-size: 12px; }
        .incomplete-candidate { padding: .6rem; border-left: 3px solid #a16d13; margin-top: .7rem; }
        .checklist-status.is-completed { background: #e9f6ed; color: #176333; }
        .checklist-status.is-in_progress { background: #e4f2ff; color: #174d7a; }
        .checklist-status.is-planned { background: #eef0f3; color: #485365; }
        .checklist-status.is-still_needed,.checklist-marker { background: #fff2d5; color: #76510b; }
        .checklist-marker,.checklist-alternatives { display: block; margin-top: .3rem; font-size: 12px; }
        .checklist-note { margin-bottom: 0; font-size: 13px; color: #53627a; }
        @media (max-width: 520px) {
          .comparison-disclosure-content { padding: .7rem; }
          .major-checklist th,.major-checklist td { padding: .5rem .25rem; font-size: 12px; }
          .checklist-marker,.checklist-alternatives { font-size: 11px; }
        }
        .comparison-page .plan-course-actions { display: grid; gap: .35rem; margin-top: .5rem; }
        .comparison-page .plan-course-actions select,
        .comparison-page .plan-course-actions button { width: 100%; min-height: 44px; font-size: 14px; }
        .comparison-page .plan-course-actions button { border: 1px solid #b8b8c0; border-radius: .7rem; background: #fff; color: #253753; cursor: pointer; }
        .comparison-page .plan-course-edit-feedback.is-error { padding: .45rem .55rem; border: 1px solid #c85a4c; border-radius: .25rem; background: #fff2ef; color: #6f2119; font-weight: 600; }
        .comparison-page .plan-course-edit-feedback { padding: .65rem; margin: .25rem 0; background: #edf7f0; color: #195e36; border: 1px solid #a5c9b1; border-radius: .7rem; }
        .comparison-page .compact-schedule .comparison-editable-course { display: grid; gap: .05rem; padding: 0; font-size: 13px; }
        .comparison-page .comparison-course-controls { display: flex; flex-wrap: nowrap; align-items: flex-start; gap: .1rem; min-width: 0; }
        .comparison-page .comparison-editable-course .plan-course-actions { display: block; flex: 1; margin: 0; min-width: 0; }
        .comparison-page .comparison-editable-course .course-drag-handle { flex: 0 0 20px; padding: 2px; margin: 0; font-size: 15px; line-height: 24px; border: 0; background: transparent; text-align: center; }
        .comparison-page .comparison-editable-course .plan-course-actions > button { display: block; padding: 3px 2px; margin: 0; font-size: 16px; font-weight: 700; line-height: 1.3; min-height: 30px; width: auto; text-align: left; border: 0; border-radius: 4px; background: transparent; box-shadow: none; }
        .comparison-page .comparison-editable-course .plan-course-actions > button:hover { background: #f1ebfa; }
        .comparison-page .comparison-editable-course.comparison-different-course { background: #eee3ff; box-shadow: inset 4px 0 #6b3fa0; border-radius: 4px; }
        .comparison-page .comparison-editable-course.comparison-different-course button { color: #351b57; }
        .comparison-page .comparison-editable-course.comparison-shared-course button { color: #334155; }
        .comparison-page .comparison-fixed-course { display: grid; gap: 2px; margin-left: calc(20px + .1rem); padding: 3px 2px; line-height: 1.35; }
        .comparison-page .comparison-fixed-course strong { font-size: 16px; }
        .comparison-page .comparison-fixed-course small { font-size: 11px; font-weight: 400; color: #64748b; }
        .comparison-page .comparison-course-meta { display: grid; gap: .08rem; margin: 0 0 .25rem calc(20px + .1rem); color: #53627a; font-size: 12px; font-weight: 400; line-height: 1.35; }
        .comparison-page .comparison-course-meta .comparison-course-title { color: #3f4e64; font-size: 14px; line-height: 1.35; }
        .comparison-page .comparison-course-meta .plan-course-availability { font-size: 12px; }
        .comparison-page .comparison-course-meta .plan-course-approval strong { display: block; color: #76510b; font-weight: 700; }
        .comparison-page .comparison-course-meta .plan-course-approval span { display: block; color: #53627a; font-size: 12px; font-weight: 400; }
        .comparison-page .comparison-course-meta .course-constraint-note { color: #35445d; font-weight: 650; }
        .comparison-page .comparison-course-meta .summer-term-note { color: #68758a; font-size: 11px; }
        .comparison-page .comparison-edit-status { margin: .25rem .7rem; font-size: 12px; }
        .comparison-page .comparison-undo { margin: .25rem .7rem; padding: .25rem .5rem; font-size: 12px; }
        .comparison-page .comparison-plan-card .comparison-undo,
        .comparison-page .comparison-plan-card .download-plan-button {
          display: block;
          box-sizing: border-box;
          width: calc(100% - 1.4rem);
          min-height: 44px;
          margin: .25rem .7rem;
          padding: .65rem .85rem;
          font-size: 14px;
          line-height: 1.2;
        }
        .comparison-page .comparison-plan-card .extra-course-picker { margin: .25rem .7rem; }
        .comparison-page .comparison-plan-card .extra-course-picker > button {
          box-sizing: border-box;
          width: 100%;
          min-height: 44px;
          margin: 0;
          padding: .65rem .85rem;
          font-size: 14px;
          line-height: 1.2;
        }
        .comparison-page .compact-schedule tr.drop-allowed { background: #eaf8f0; outline: 2px solid #168264; }
        .comparison-page .compact-schedule tr.drop-conditional { background: #fffbeb; outline: 2px dashed #946200; }
        .comparison-page .compact-schedule tr.drop-unavailable, .comparison-page .compact-schedule tr.drop-blocked, .comparison-page .compact-schedule tr.drop-review_required { background: #f3f3f5; outline: 2px solid #a6a6af; }
        .comparison-page .comparison-drop-hint { display: block; font-size: .7rem; font-weight: normal; }
        .comparison-page .download-plan-button { margin: .5rem 0; width: 100%; background: #49317c; border-color: #49317c; color: white; }
        .comparison-page .plan-course-actions { position: relative; }
        .comparison-page .course-change-panel { position: static; width: 100%; min-width: 0; box-sizing: border-box; margin: .25rem 0 .5rem; padding: .4rem; border: 1px solid #e4dfee; border-radius: .4rem; background: #faf8fd; display: grid; gap: .3rem; overflow-wrap: anywhere; }
        .comparison-page .course-change-panel .close-course-options { justify-self: end; width: auto; border: 0; background: transparent; padding: .2rem; font-size: 12px; min-height: 30px; }
        .comparison-page .change-option-group { margin: 0; padding: 0; }
        .comparison-page .change-option-group + .change-option-group { border-top: 1px solid #e4dfee; margin-top: .3rem; padding-top: .3rem; }
        .comparison-page .course-change-panel .change-menu-heading { display: block; padding: .3rem .5rem; font-size: 13px; color: #49317c; }
        .comparison-page .course-change-panel .change-menu-option { display: flex; align-items: center; justify-content: space-between; gap: .5rem; width: 100%; padding: .4rem .5rem; border: 0; border-radius: .35rem; background: transparent; box-shadow: none; color: #30234c; text-align: left; font-size: .85rem; min-height: 44px; }
        .comparison-page .course-change-panel .change-menu-option:hover,
        .comparison-page .course-change-panel .change-menu-option:focus-visible { background: #f1ebfa; }
        .comparison-page .change-menu-option small { display: block; flex-basis: 100%; color: #775715; font-size: 11px; font-weight: 400; }
        .comparison-page .course-change-panel .change-menu-option { flex-wrap: wrap; gap: .1rem; min-height: 36px; font-size: 13px; }
        .comparison-page .change-confirm-title { font-size: 14px; }
        .comparison-page .change-confirm-term { font-size: 13px; color: #53627a; }
        .comparison-page .change-confirm-actions { display: flex; gap: .5rem; }
        .comparison-page .course-change-panel .change-confirm-actions button { width: auto; min-height: 36px; padding: .35rem .75rem; font-size: 13px; }
        .comparison-page .change-confirm-actions button:first-child { background: #49317c; border-color: #49317c; color: white; }
        .comparison-page .course-change-panel .change-confirm-warning { color: #775715; font-size: 12px; }
        .comparison-page .course-change-panel > details { padding: .4rem .5rem; font-size: .75rem; }
        .comparison-page .course-change-panel[hidden] { display: none; }
        .comparison-page .course-change-panel button, .comparison-page .course-change-panel details,
        .comparison-page .course-change-panel label, .comparison-page .course-change-panel select { margin: 0; }
        .comparison-page .course-change-panel p { margin: .25rem 0; font-size: 13px; line-height: 1.45; }
        .comparison-page .course-change-panel select { width: 100%; max-width: 100%; min-height: 44px; }
        .comparison-page .course-change-panel label { min-width: 0; font-size: 13px; }
        .comparison-page .course-reason-details { font-size: 12px; line-height: 1.4; }
        .comparison-page .offering-pattern { display: block; color: #52627a; font-size: 12px; margin-top: .3rem; }
        .comparison-page .comparison-heading-row h1 { font-size: clamp(1.6rem, 4vw, 2.2rem); line-height: 1.2; word-break: normal; }
        .comparison-page .comparison-topbar { flex-wrap: wrap; gap: .75rem; }
        .comparison-page .comparison-brand { flex: 0 0 auto; white-space: nowrap; font-size: 21px; }
        .comparison-page .comparison-brand-logo { width: 110px; }
        .comparison-page .comparison-actions { flex-wrap: wrap; margin-left: auto; gap: .5rem; }
        .comparison-page .comparison-actions > button { flex: 0 0 auto; white-space: nowrap; min-height: 40px; }
        .comparison-page .result-progress { min-width: 0; max-width: 100%; }
        .comparison-page .comparison-student { flex-shrink: 0; }
        .comparison-page summary { cursor: pointer; }
        .comparison-page button:focus-visible, .comparison-page select:focus-visible, .comparison-page summary:focus-visible { outline: 3px solid #365fba; outline-offset: 3px; }
        .plan-edit-status { margin: .75rem 0; color: #33425d; }
        .candidate-outcomes { margin: .75rem 0 0; }
        .candidate-outcomes h2 { margin: 0 0 .5rem; font-size: 1rem; }
        .candidate-outcomes ul { margin: 0; padding-left: 1.2rem; }
        .candidate-outcomes p { margin: .55rem 0 0; }
        .comparison-page .result-diagnostics { font-size: 14px; line-height: 1.5; }
        .comparison-page .result-diagnostics > summary { font-size: 15px; }
        .comparison-page .result-diagnostics .candidate-outcomes li { font-size: 14px; }
        .choose-plan-button {
          width: calc(100% - 2rem);
          min-height: 0;
          margin: 0 1rem 1rem;
          padding: .72rem 1rem;
          border: 1px solid #6d5a86;
          border-radius: .42rem;
          background: #fff;
          color: #2f1c57;
          font-size: 16px;
          font-weight: 700;
          cursor: pointer;
        }
        .choose-plan-button:hover { background: #f2eef7; }
        .comparison-plan-card.is-selected .choose-plan-button {
          border-color: transparent;
          background: #4b2e83;
          color: #fff;
        }
        .comparison-plan-card.is-selected .choose-plan-button:hover {
          background: #2f1c57;
        }
        .comparison-empty {
          padding: 1.25rem;
          border: 1px solid #bdc9da;
          border-radius: .7rem;
          background: #fff;
          color: #41506a;
        }
        .result-progress ol { display: flex; flex-wrap: wrap; gap: .65rem; margin: 0; padding: 0; list-style: none; }
        .result-progress li { color: #667085; font-size: 14.4px; }
        .result-progress li::before { content: "✓ "; color: #4b2e83; }
        .result-progress li.is-current { color: #18202b; font-weight: 700; }
        .result-progress li.is-current::before { content: "● "; }
        .result-progress button {
          margin: 0;
          padding: 0;
          border: 0;
          background: transparent;
          color: inherit;
          font: inherit;
          cursor: pointer;
        }
        .no-plan-state {
          padding: 1.25rem;
          border: 1px solid #bdc9da;
          border-radius: .7rem;
          background: #fff;
        }
        .no-plan-state h2 { margin: 0; color: #18202b; font-size: 22px; line-height: 1.3; }
        .no-plan-state > p { color: #53627a; line-height: 1.5; }
        .no-plan-question-list, .no-plan-action-list { margin: .8rem 0; padding-left: 1.25rem; }
        .no-plan-primary {
          width: auto;
          min-height: 42px;
          padding: .65rem .9rem;
          border: 1px solid #172a40;
          border-radius: 7px;
          background: #2f1c57;
          color: #fff;
          font-weight: 700;
          cursor: pointer;
        }
        .result-diagnostics {
          margin-top: 1rem;
          padding: .75rem .9rem;
          border: 1px solid #cfd8e6;
          border-radius: 9px;
          background: #fff;
          color: #33425d;
        }
        .result-diagnostics > summary { cursor: pointer; color: #4b2e83; font-weight: 700; }
        .result-diagnostics .candidate-outcomes,
        .result-diagnostics .planning-gaps { margin: .75rem 0 0; }
        .comparison-actions .clear-all-results { color: #5a397d; }
        .accelerated-result {
          margin: 0 0 1rem;
          padding: 1rem 1.1rem;
          border: 1px solid #e1d8ee;
          border-left: 4px solid #4f2d7f;
          border-radius: .9rem;
          background: #f7f4fb;
        }
        .accelerated-result h2 { margin: 0; color: #302044; font-size: 1.25rem; line-height: 1.3; }
        .accelerated-result > p { margin: .75rem 0 0; color: #4c4357; font-size: .9375rem; line-height: 1.5; }
        .accelerated-result-status { display: inline-block; margin-left: .35rem; color: #4f2d7f; }
        .accelerated-target-list { display: grid; gap: .35rem; margin: .75rem 0 0; }
        .accelerated-target-list > div { display: grid; grid-template-columns: 9.5rem minmax(0, 1fr); gap: .5rem; align-items: baseline; }
        .accelerated-target-list dt { color: #514b5e; font-weight: 650; }
        .accelerated-target-list dd { min-width: 0; margin: 0; color: #302044; }
        .planning-guide-disclaimer { margin: 1.2rem 0 0; color: #626a75; font-size: 13px; text-align: center; }
        .comparison-page .advisor-attention,
        .comparison-page .plan-notes {
          margin: 1rem 0;
          padding: .8rem 1rem;
          border: 1px solid #d7a633;
          border-radius: .55rem;
          background: #fff8e3;
          color: #2b3445;
          font-size: 12px;
        }
        .comparison-page .advisor-attention h2 {
          margin: 0 0 .4rem;
          color: #8b5500;
          font-size: 14px;
        }
        .comparison-page .advisor-attention-scope {
          margin: -.15rem 0 .5rem;
          color: #6b7280;
          font-size: 11px;
          font-style: italic;
        }
        .comparison-page .advisor-attention h3 {
          margin: 0;
          color: #1d4ed8;
          font-size: 13px;
        }
        .comparison-page .advisor-attention h4 {
          margin: 0 0 .3rem;
          color: #714600;
          font-size: 12px;
        }
        .comparison-page .advisor-attention-item + .advisor-attention-item {
          margin-top: .5rem;
          padding-top: .5rem;
          border-top: 1px solid #e4c679;
        }
        .comparison-page .advisor-attention-item p { margin: .25rem 0 0; }
        .comparison-page .advisor-attention-groups {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: .65rem 1rem;
          margin-top: .5rem;
        }
        .comparison-page .advisor-attention-groups ul {
          margin: .3rem 0 0;
          padding-left: 1rem;
        }
        .comparison-page .offering-pattern-note {
          padding-left: .55rem;
          border-left: 3px solid #8fb2ee;
        }
        .comparison-page .planning-gaps {
          margin-top: 1rem;
          border-color: #d17a65;
          background: #fff2ed;
        }
        .comparison-page .plan-notes ul {
          margin: .45rem 0 0;
          padding-left: 1.1rem;
        }
        .comparison-page .comparison-disclosure {
          margin: 1rem 0;
          padding: 0;
          overflow: hidden;
          border: 1px solid #d9d9df;
          border-radius: 1rem;
          background: #fff;
          color: #30343b;
          font-size: .9375rem;
          line-height: 1.5;
        }
        .comparison-page .comparison-disclosure > summary {
          display: flex;
          min-height: 64px;
          align-items: center;
          justify-content: space-between;
          gap: 1rem;
          padding: .85rem 1.1rem;
          color: #2f1c57;
          font-size: 1rem;
          font-weight: 600;
          line-height: 1.35;
          list-style: none;
          cursor: pointer;
        }
        .comparison-page .comparison-disclosure > summary::-webkit-details-marker { display: none; }
        .comparison-page .comparison-disclosure > summary::after {
          width: .55rem;
          height: .55rem;
          flex: 0 0 auto;
          border-right: 2px solid #7a8497;
          border-bottom: 2px solid #7a8497;
          content: "";
          transform: rotate(-45deg);
          transition: transform .15s ease;
        }
        .comparison-page .comparison-disclosure > summary:hover { background: #fafafd; }
        .comparison-page .comparison-disclosure[open] > summary { border-bottom: 1px solid #e7e8ed; }
        .comparison-page .comparison-disclosure[open] > summary::after { transform: rotate(45deg); }
        .comparison-page .comparison-disclosure-content { padding: 1rem; }
        .comparison-page .comparison-disclosure-content > :first-child { margin-top: 0; }
        .comparison-page .comparison-disclosure-content > :last-child { margin-bottom: 0; }
        .comparison-page .student-evidence-group + .student-evidence-group { margin-top: 1rem; padding-top: 1rem; border-top: 1px solid #e7e8ed; }
        .comparison-page .student-evidence-title { margin: 0 0 .45rem; color: #2f1c57; font-size: 1rem; font-weight: 650; line-height: 1.35; }
        .comparison-page .student-evidence-content { font-size: .875rem; line-height: 1.5; }
        .comparison-page .student-evidence-group,
        .comparison-page .student-evidence-content,
        .comparison-page .upcoming-course-entry { min-width: 0; }
        .comparison-page .student-evidence-content p { margin: .25rem 0 .5rem; }
        .comparison-page .student-evidence-content ul { margin: .4rem 0; padding-left: 1.15rem; }
        .comparison-page .student-evidence-content li + li { margin-top: .45rem; }
        .comparison-page .upcoming-course-heading { overflow-wrap: anywhere; }
        .comparison-page .upcoming-course-title { text-decoration: underline; text-decoration-color: #b8a5d2; text-decoration-thickness: .06em; text-underline-offset: .15em; }
        .comparison-page .upcoming-course-times { margin-left: .85rem; color: #505b6b; overflow-wrap: anywhere; }
        .comparison-page .upfront-conditions {
          padding: 1rem 1.1rem;
          border-color: #e7d9b4;
          border-left: 4px solid #d1a148;
          border-radius: .9rem;
          background: #fffdf7;
          color: #30343b;
          font-size: .9375rem;
          line-height: 1.5;
        }
        .comparison-page .upfront-conditions h2 {
          margin: 0 0 .75rem;
          color: #2f1c57;
          font-size: 1.25rem;
          font-weight: 700;
          line-height: 1.25;
          letter-spacing: -.02em;
        }
        .comparison-page .upfront-conditions h3 {
          margin: 0 0 .3rem;
          color: #46516a;
          font-size: 1rem;
          font-weight: 650;
          line-height: 1.35;
        }
        .comparison-page .upfront-conditions > div + div { margin-top: .9rem; }
        .comparison-page .upfront-conditions ul {
          display: grid;
          gap: .45rem;
          margin: .25rem 0 0;
          padding-left: 1.15rem;
          list-style: disc;
        }
        .comparison-page .upfront-conditions li { padding-left: .1rem; }
        @media (max-width: 760px) {
          .comparison-grid { grid-template-columns: 1fr; }
          .comparison-course-status { grid-template-columns: 1fr 1fr; }
          .comparison-plan-summary { min-height: 0; }
          .comparison-page .advisor-attention-groups { grid-template-columns: 1fr; }
        }
        @media (max-width: 700px) {
          .comparison-topbar {
            align-items: flex-start;
            flex-wrap: wrap;
            padding: .8rem 1rem;
          }
          .comparison-brand { flex-basis: 100%; }
          .comparison-student {
            width: 100%;
            min-width: 0;
            order: 3;
            margin: 0;
          }
          .comparison-actions {
            width: 100%;
            min-width: 0;
            margin: 0;
            flex-wrap: wrap;
          }
          .comparison-actions > button {
            min-width: 0;
            flex: 1 1 9rem;
            white-space: normal;
          }
          .comparison-content { width: min(100% - 1.25rem, 1460px); }
          .compact-schedule th:first-child { width: 4.5rem; }
          .compact-schedule th:nth-child(2) { width: 3rem; }
          .compact-schedule td.comparison-academic-year { font-size: 12px; }
          .comparison-heading-row {
            align-items: flex-start;
            flex-direction: column;
          }
          .comparison-grid,
          .comparison-plan-card { max-width: 100%; min-width: 0; }
          .compact-schedule { font-size: 13px; }
          .compact-schedule th,
          .compact-schedule td {
            white-space: normal !important;
            overflow-wrap: anywhere;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .comparison-page,
          .comparison-page.is-exiting { animation: none; }
        }
      `;
