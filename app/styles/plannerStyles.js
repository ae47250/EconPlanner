import css from "styled-jsx/css";

export const plannerStyles = css.global`
        :root {
          --cp7-ink: #18202b;
          --cp7-muted: #5b6470;
          --cp7-border: #ddd8e4;
          --cp7-border-strong: #8a8096;
          --cp7-surface: #ffffff;
          --cp7-soft: #f7f5f9;
          --cp7-selected: #f0edf7;
          --cp7-accent: #4b2e83;
          --cp7-accent-dark: #2f1c57;
          --cp7-aqua: #2a8f9e;
          --cp7-gold: #b77912;
          --cp7-warning: #fff8e8;
          --cp7-warning-border: #c18b2d;
          --cp7-danger: #8a2c25;
        }
        body {
          margin: 0;
          background: #f1f3f5 !important;
          color: var(--cp7-ink) !important;
          font-family: Arial, sans-serif;
        }
        main.cp7-container {
          box-sizing: border-box;
          width: min(1180px, calc(100% - 2rem));
          max-width: none;
          margin: 0 auto;
          padding: 0 0 4rem;
          color: var(--cp7-ink);
          font-size: 15px;
        }
        main.cp7-container *, main.cp7-container *::before, main.cp7-container *::after { box-sizing: border-box; }
        main.cp7-container button,
        main.cp7-container input,
        main.cp7-container select { font-size: inherit; }
        main.cp7-container button:focus-visible,
        main.cp7-container input:focus-visible,
        main.cp7-container select:focus-visible,
        main.cp7-container summary:focus-visible,
        main.cp7-container [tabindex]:focus-visible {
          outline: 3px solid var(--cp7-aqua);
          outline-offset: 3px;
        }
        .cp7-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 2rem;
          padding: 1rem 0;
          border-bottom: 1px solid var(--cp7-border);
        }
        .cp7-brand-block { display: flex; align-items: flex-start; flex: 0 0 auto; flex-direction: column; gap: .35rem; }
        .cp7-brand-logo { display: block; width: 168px; height: auto; }
        .cp7-brand { margin: 0; color: var(--cp7-accent); font-size: 21px; letter-spacing: -.02em; }
        .cp7-progress ol { display: flex; gap: .4rem; margin: 0; padding: 0; list-style: none; }
        .cp7-progress li {
          display: flex;
          align-items: center;
          gap: .4rem;
          padding: .35rem .55rem;
          color: var(--cp7-muted);
          font-size: 15.6px;
        }
        .cp7-progress li::before {
          width: .52rem;
          height: .52rem;
          border: 1px solid #98a1ab;
          border-radius: 50%;
          background: #fff;
          content: "";
        }
        .cp7-progress li.is-current { color: var(--cp7-ink); font-weight: 700; }
        .cp7-progress li.is-current::before,
        .cp7-progress li.is-complete::before { border-color: var(--cp7-accent); background: var(--cp7-accent); }
        .cp7-progress button {
          margin: 0;
          padding: 0;
          border: 0;
          background: transparent;
          color: inherit;
          font: inherit;
          cursor: pointer;
        }
        .cp7-page-heading { padding: 2rem 0 1.25rem; }
        .cp7-page-heading h1 {
          margin: 0;
          color: var(--cp7-ink);
          font-size: clamp(28px, 4vw, 40px);
          letter-spacing: -.035em;
          line-height: 1.08;
        }
        .cp7-page-heading p { max-width: 46rem; margin: .55rem 0 0; color: var(--cp7-muted); font-size: 16px; line-height: 1.5; }
        .cp7-intake-layout {
          display: grid;
          grid-template-columns: minmax(0, 1fr);
          gap: 1.25rem;
          align-items: start;
        }
        .cp7-left { min-width: 0; }
        main.cp7-container .cp7-task-card,
        main.cp7-container .cp7-summary {
          padding: 1.35rem;
          border: 1px solid var(--cp7-border);
          border-radius: 10px;
          background: var(--cp7-surface);
          box-shadow: 0 3px 12px rgba(27, 39, 51, .045);
        }
        .cp7-task-card h2,
        main.cp7-container .cp7-summary h2 { margin: 0; color: var(--cp7-ink); font-size: 23px; line-height: 1.2; }
        .cp7-task-intro { margin: .45rem 0 1.35rem; color: var(--cp7-muted); line-height: 1.5; }
        .cp7-question-label { display: block; margin-bottom: .65rem; font-weight: 700; }
        .standing-options { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: .55rem; }
        main.cp7-container .standing-option,
        main.cp7-container .early-toggle,
        main.cp7-container .custom-timeline-trigger,
        main.cp7-container .standard-timeline-trigger,
        main.cp7-container .secondary-action {
          width: auto;
          min-height: 44px;
          margin: 0;
          padding: .65rem .8rem;
          border: 1px solid var(--cp7-border-strong);
          border-radius: 7px;
          background: #fff;
          color: var(--cp7-ink);
          cursor: pointer;
        }
        main.cp7-container .standing-option.is-selected,
        main.cp7-container .early-toggle.is-selected {
          border-color: transparent;
          background: var(--cp7-selected);
          font-weight: 700;
        }
        .standing-feedback { margin: .75rem 0 0; padding: .7rem .8rem; border-left: 3px solid var(--cp7-aqua); background: var(--cp7-soft); color: #344151; }
        .early-option, .custom-timeline-disclosure { margin-top: 1.25rem; padding-top: 1.1rem; border-top: 1px solid var(--cp7-border); }
        .current-term-option { margin-top: 1rem; padding: .75rem .85rem; border: 1px solid var(--cp7-border); border-radius: 7px; background: var(--cp7-soft); }
        .current-term-option label { display: flex; align-items: flex-start; gap: .65rem; min-width: 0; line-height: 1.45; }
        .current-term-option input { flex: 0 0 auto; width: 18px; height: 18px; margin-top: .12rem; accent-color: var(--cp7-accent); }
        .current-term-option input:focus-visible { outline: 3px solid var(--cp7-aqua); outline-offset: 3px; }
        .current-term-option span { min-width: 0; overflow-wrap: anywhere; }
        main.cp7-container .early-toggle { display: inline-flex; align-items: center; gap: .55rem; text-align: left; }
        .early-option p, .custom-timeline-copy { margin: .4rem 0 0; color: var(--cp7-muted); font-size: 14px; line-height: 1.45; }
        main.cp7-container .custom-timeline-trigger,
        main.cp7-container .standard-timeline-trigger { border-color: transparent; padding-left: 0; color: var(--cp7-accent); font-weight: 700; }
        .catalog-planning-note { margin-top: 1.1rem; padding: .8rem .9rem; border-left: 3px solid var(--cp7-gold); background: #fffaf0; color: #473c2d; line-height: 1.45; }
        .catalog-planning-note p { margin: .3rem 0 0; font-size: 13px; }
        .custom-timeline-panel {
          display: grid;
          gap: 1rem;
          margin-top: .65rem;
          padding: 1rem;
          border: 1px solid var(--cp7-border);
          border-radius: 8px;
          background: var(--cp7-soft);
        }
        .custom-fields, .advanced-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .85rem; }
        .custom-fields label, .advanced-fields label {
          display: grid;
          gap: .4rem;
          color: #303a46;
          font-weight: 700;
        }
        .custom-fields select, .advanced-fields input, .advanced-fields select {
          width: 100%;
          min-height: 42px;
          padding: .55rem .65rem;
          border: 1px solid var(--cp7-border-strong);
          border-radius: 6px;
          background: #fff;
          color: var(--cp7-ink);
          font-weight: 400;
        }
        .custom-target { margin: 0; color: #344151; }
        .custom-errors { margin: 0; padding-left: 1.2rem; color: var(--cp7-danger); }
        .more-details { margin-top: 1.25rem; border-top: 1px solid var(--cp7-border); padding-top: 1rem; }
        .more-details > summary { color: var(--cp7-accent); cursor: pointer; font-weight: 700; }
        .advanced-fields { margin-top: 1rem; }
        .non-major-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .6rem; margin-top: .75rem; }
        .non-major-fields label, .study-abroad-fields label { display: grid; gap: .3rem; font-size: 13px; font-weight: 700; }
        .non-major-fields select, .study-abroad-fields select, .study-abroad-fields input[type="text"], .study-abroad-fields textarea { min-height: 40px; padding: .45rem .55rem; border: 1px solid var(--cp7-border-strong); border-radius: 6px; background: #fff; font: inherit; }
        .study-abroad-fields textarea { min-height: 88px; resize: vertical; }
        .study-abroad-fields label:has(input[type="checkbox"]) { display: flex; align-items: flex-start; gap: .45rem; }
        .study-abroad-fields { display: grid; gap: .65rem; margin: .9rem 0; padding: .8rem; border: 1px solid #cae0e4; border-radius: 8px; background: #f2fafb; }
        .study-abroad-fields p { margin: 0; color: #285b63; }
        main.cp7-container .study-abroad-toggle { display: inline-flex; width: fit-content; min-height: 42px; align-items: center; gap: .4rem; padding: .55rem .7rem; border: 1px solid #8ab7bf; border-radius: 7px; background: #fff; color: #24434a; font-weight: 700; cursor: pointer; }
        main.cp7-container .study-abroad-toggle.is-selected { border-color: transparent; background: #e2f2f4; }
        .step-two-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
        main.cp7-container .secondary-action { flex: 0 0 auto; color: #244f85; }
        .course-toolbar { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .75rem; align-items: end; margin: 1rem 0 1.25rem; }
        .course-toolbar label { display: grid; gap: .35rem; font-weight: 700; }
        .course-toolbar input {
          width: 100%;
          min-height: 42px;
          padding: .55rem .65rem;
          border: 1px solid var(--cp7-border-strong);
          border-radius: 6px;
        }
        main.cp7-container .clear-courses {
          width: auto;
          min-height: 42px;
          margin: 0;
          padding: .55rem .8rem;
          border: 1px solid var(--cp7-border-strong);
          border-radius: 6px;
          background: #fff;
          color: var(--cp7-ink);
          cursor: pointer;
        }
        .course-priority-section + .course-priority-section { margin-top: 1.35rem; }
        .course-priority-section > h3 { margin: 0 0 .45rem; color: var(--cp7-ink); font-size: 16px; }
        main.cp7-container .course-columns { display: grid; grid-template-columns: 1fr; gap: 0; }
        main.cp7-container .course-row {
          position: static;
          display: block;
          min-width: 0;
          padding: .8rem 0;
          border: 0;
          border-bottom: 1px solid #e4e7eb;
          background: transparent;
        }
        main.cp7-container .course-row-main {
          display: grid;
          grid-template-columns: minmax(175px, 1fr) minmax(370px, auto);
          gap: 1rem;
          align-items: center;
        }
        main.cp7-container .course-name { display: grid; gap: .18rem; min-width: 0; }
        main.cp7-container .course-name strong { color: var(--cp7-ink); font-size: 15px; }
        main.cp7-container .course-name span { color: var(--cp7-muted); font-size: 13px; line-height: 1.3; }
        main.cp7-container .course-toggles {
          display: grid;
          grid-template-columns: repeat(2, minmax(105px, 1fr));
          gap: .35rem;
          justify-content: stretch;
          outline: 0;
          box-shadow: none;
        }
        main.cp7-container .course-toggles:focus,
        main.cp7-container .course-toggles:focus-visible,
        main.cp7-container .course-toggles:focus-within { outline: 0; box-shadow: none; }
        main.cp7-container button.course-toggle,
        main.cp7-container .completion-source-options button {
          display: inline-flex;
          width: auto;
          min-width: 0;
          min-height: 38px;
          align-items: center;
          justify-content: center;
          gap: .35rem;
          margin: 0;
          padding: .48rem .55rem;
          border: 1px solid #aeb6bf;
          border-radius: 6px;
          background: #fff;
          color: #303a46;
          font-size: 13px;
          font-weight: 600;
          line-height: 1.2;
          cursor: pointer;
        }
        main.cp7-container button.course-toggle.is-selected,
        main.cp7-container .completion-source-options button.is-selected {
          border-color: transparent;
          background: var(--cp7-selected);
          color: var(--cp7-ink);
        }
        main.cp7-container button.course-toggle:focus-visible {
          position: relative;
          z-index: 1;
          outline: 3px solid var(--cp7-aqua);
          outline-offset: 2px;
          box-shadow: none;
        }
        .selection-check { display: inline-block; width: 1em; color: var(--cp7-accent); font-weight: 800; }
        .course-status-note { color: var(--cp7-muted); font-size: 13px; }
        .course-requirement-group { margin: .55rem 0; padding: .7rem .85rem; border: 1px solid var(--cp7-border); border-radius: 8px; background: #fafbfc; }
        .course-requirement-heading { display: flex; justify-content: space-between; gap: 1rem; color: var(--cp7-muted); font-size: 13px; }
        .course-requirement-heading strong { color: var(--cp7-ink); font-size: 14px; }
        .completion-source { display: flex; align-items: center; flex-wrap: wrap; gap: .25rem .55rem; margin: .35rem 0 0; }
        main.cp7-container .completion-source-trigger { width: auto; margin: 0; padding: .15rem 0; border: 0; background: transparent; color: #4b617a; cursor: pointer; font-size: 12px; text-decoration: underline; text-underline-offset: 2px; }
        .completion-source-current { color: var(--cp7-muted); font-size: 12px; }
        .completion-source-panel { flex: 0 0 100%; }
        .completion-source-options { display: flex; gap: .4rem; flex-wrap: wrap; margin-top: .25rem; }
        main.cp7-container .completion-source-options button { min-height: 32px; padding: .35rem .5rem; font-size: 12px; }
        .completion-source p { margin: .4rem 0 0; color: var(--cp7-muted); font-size: 12px; }
        .inline-prerequisite { margin: .7rem 0 0; padding: .8rem; border: 1px solid #b9c3ce; border-radius: 7px; background: #f6f8fa; }
        .inline-prerequisite.has-conflict { border-color: #b76458; background: #fff6f3; }
        .inline-prerequisite > p { margin: 0 0 .65rem; }
        .prerequisite-question + .prerequisite-question { margin-top: .75rem; padding-top: .75rem; border-top: 1px solid var(--cp7-border); }
        .prerequisite-question-heading { display: grid; grid-template-columns: minmax(165px, 1fr) minmax(370px, 2fr); gap: 1rem; margin-bottom: .25rem; color: var(--cp7-muted); font-size: 13px; }
        .prerequisite-question-heading strong { grid-column: 2; color: var(--cp7-ink); text-align: center; }
        .prerequisite-option { display: grid; grid-template-columns: minmax(165px, 1fr) minmax(370px, 2fr); gap: 1rem; align-items: center; padding: .45rem 0; }
        .prerequisite-name { display: grid; gap: .1rem; }
        .prerequisite-name small { color: var(--cp7-muted); }
        .prerequisite-conflict { margin-top: .55rem; padding: .65rem .75rem; border-left: 3px solid var(--cp7-danger); background: #fff; color: #64251f; }
        .prerequisite-conflict p { margin: .2rem 0; }
        main.cp7-container .course-accordion { margin-top: 1.35rem; border: 1px solid var(--cp7-border); border-radius: 8px; background: #fafbfc; }
        main.cp7-container .course-accordion > summary { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: .8rem .9rem; color: var(--cp7-ink); cursor: pointer; font-weight: 700; }
        main.cp7-container .course-accordion-title { min-width: 0; }
        main.cp7-container .course-accordion-count { flex: 0 0 auto; }
        main.cp7-container .course-accordion .course-columns { padding: 0 .9rem .55rem; }
        main.cp7-container .cp7-summary { position: sticky; top: 1rem; max-height: calc(100vh - 2rem); overflow: auto; }
        .summary-details { display: grid; gap: 0; margin: .8rem 0 0; }
        .summary-details > div { padding: .62rem 0; border-bottom: 1px solid #e5e8eb; }
        .summary-details dt { color: var(--cp7-muted); font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .035em; }
        .summary-details dd { margin: .24rem 0 0; color: var(--cp7-ink); line-height: 1.4; }
        .summary-none { color: var(--cp7-muted); }
        .summary-show-all { margin-top: .35rem; }
        .summary-show-all summary { color: #244f85; cursor: pointer; font-size: 13px; font-weight: 700; }
        .summary-show-all span { display: block; margin-top: .35rem; }
        .summary-attention { margin-top: .8rem; padding: .7rem; border: 1px solid var(--cp7-warning-border); border-radius: 7px; background: var(--cp7-warning); font-size: 13px; }
        .summary-attention p { margin: .4rem 0 0; }
        .summary-attention ul { display: grid; gap: .3rem; margin: .45rem 0 0; padding: 0; list-style: none; }
        .summary-attention button { padding: 0; border: 0; background: transparent; color: #704c08; text-align: left; text-decoration: underline; cursor: pointer; }
        .summary-status { margin: .8rem 0 0; color: #6c2c25; font-size: 13px; line-height: 1.4; }
        main.cp7-container .clear-all-button { width: 100%; min-height: 43px; margin: .85rem 0 0; padding: .6rem .8rem; border: 1px solid var(--cp7-accent); border-radius: 7px; background: #fff; color: var(--cp7-accent); font-weight: 700; cursor: pointer; }
        main.cp7-container .primary-action {
          width: 100%;
          min-height: 45px;
          margin: 1rem 0 0;
          padding: .7rem 1rem;
          border: 1px solid var(--cp7-accent-dark);
          border-radius: 7px;
          background: var(--cp7-accent-dark);
          color: #fff;
          font-size: 15px;
          font-weight: 700;
          cursor: pointer;
        }
        main.cp7-container .primary-action:hover { background: #21123f; }
        main.cp7-container .primary-action:disabled { cursor: wait; opacity: .68; }
        @media (min-width: 861px) {
          main.cp7-container .cp7-intake-layout {
            grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr);
          }
        }
        @media (max-width: 860px) {
          main.cp7-container { width: min(100% - 1rem, 720px); }
          .cp7-header { align-items: flex-start; flex-direction: column; gap: .55rem; }
          .cp7-progress { width: 100%; overflow-x: auto; }
          .cp7-progress ol { justify-content: space-between; min-width: 330px; }
          main.cp7-container .cp7-intake-layout { grid-template-columns: minmax(0, 1fr) !important; }
          main.cp7-container .cp7-summary {
            position: static;
            grid-column: 1 !important;
            grid-row: auto !important;
            max-height: none;
            overflow: visible;
          }
        }
        @media (max-width: 620px) {
          main.cp7-container { width: 100%; padding: 0 .65rem 2rem; }
          .cp7-page-heading { padding: 1.35rem .25rem 1rem; }
          .cp7-page-heading h1 { font-size: 28px; }
          main.cp7-container .cp7-task-card,
          main.cp7-container .cp7-summary { padding: 1rem; border-radius: 8px; }
          .standing-options { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .custom-fields, .advanced-fields, .non-major-fields { grid-template-columns: 1fr; }
          .step-two-heading { display: block; }
          main.cp7-container .secondary-action { margin-top: .7rem; }
          .course-toolbar { grid-template-columns: 1fr; }
          main.cp7-container .clear-courses { justify-self: start; }
          main.cp7-container .course-row-main,
          .prerequisite-option { grid-template-columns: 1fr; gap: .55rem; }
          .prerequisite-question-heading { grid-template-columns: 1fr; }
          .prerequisite-question-heading strong { grid-column: 1; }
          main.cp7-container .course-toggles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          main.cp7-container button.course-toggle { min-height: 44px; }
          .course-requirement-heading,
          .prerequisite-question-heading { display: grid; gap: .25rem; }
        }
        @media (max-width: 360px) {
          main.cp7-container .course-toggles { grid-template-columns: 1fr; }
          main.cp7-container button.course-toggle { justify-content: flex-start; }
        }
      `;
