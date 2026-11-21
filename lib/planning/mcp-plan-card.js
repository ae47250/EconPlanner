import { openInEconPlannerUrl, publicSiteOrigin } from "./mcp-state.js";

export const planCardUri = "ui://econplanner/plan-card.html";
const mimeType = "text/html;profile=mcp-app";

export function registerPlanCard(server) {
  server.registerResource("econplanner-plan-card", planCardUri, { mimeType }, async () => ({
    contents: [{
      uri: planCardUri,
      mimeType,
      text: planCardHtml,
      _meta: {
        ui: { prefersBorder: true },
        "openai/widgetCSP": { redirect_domains: [publicSiteOrigin()].filter(Boolean) },
        "openai/widgetDescription": "Shows the Economics plans, schedules, advising notes, and the Open in EconPlanner button."
      }
    }]
  }));
}

export function planCardResult(plans, selectedPlanId, stateToken) {
  return {
    selectedPlanId,
    links: Object.fromEntries(plans.map(plan => [plan.id, openInEconPlannerUrl(stateToken, plan.id)]))
  };
}

const planCardHtml = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>EconPlanner</title>
<style>
  :root { color-scheme: light dark; font: 15px/1.5 system-ui, sans-serif; }
  body { margin: 0; color: CanvasText; background: Canvas; }
  main { padding: 16px; }
  h1 { font-size: 1.25rem; margin: 0 0 .65rem; }
  h2 { font-size: .95rem; margin: 1rem 0 .25rem; }
  p { margin: .45rem 0; }
  [role="tablist"]:not([hidden]) { display: flex; flex-wrap: wrap; gap: .4rem; margin-bottom: .8rem; }
  button { font: inherit; cursor: pointer; }
  [role="tab"] { border: 1px solid GrayText; border-radius: .5rem; padding: .3rem .65rem; background: Canvas; color: CanvasText; }
  [aria-selected="true"] { font-weight: 700; border-color: currentColor; }
  #open-plan { border: 0; border-radius: .5rem; color: white; background: #4934a9; padding: .5rem .8rem; font-weight: 650; }
  .hint { font-size: .875rem; }
  table { width: 100%; border-collapse: collapse; margin-top: .8rem; }
  th, td { padding: .45rem .35rem; text-align: left; vertical-align: top; border-bottom: 1px solid GrayText; }
  th[scope="row"] { width: 34%; }
  ul { margin: .25rem 0; padding-left: 1.2rem; }
  :focus-visible { outline: 2px solid Highlight; outline-offset: 3px; }
</style>
</head>
<body>
<main>
  <h1>Your Economics plan</h1>
  <p id="status" role="status">Loading your plan…</p>
  <div id="tabs" role="tablist" aria-label="Economics plans" hidden></div>
  <section id="plan-panel" hidden></section>
</main>
<script>
  const status = document.getElementById("status");
  const tabs = document.getElementById("tabs");
  const panel = document.getElementById("plan-panel");
  let plans = [];
  let links = {};
  let advisorContext;
  let selected = 0;
  let connected = false;
  let nextRequestId = 2;
  let openRequestId;
  let openError;

  function send(message) {
    window.parent.postMessage({ jsonrpc: "2.0", ...message }, "*");
  }

  function element(tag, value) {
    const node = document.createElement(tag);
    if (value !== undefined) node.textContent = value;
    return node;
  }

  function section(heading, items) {
    if (!items.length) return;
    const list = element("ul");
    for (const item of items) list.append(element("li", item));
    panel.append(element("h2", heading), list);
  }

  function openPlan(url) {
    openRequestId = nextRequestId++;
    openError.hidden = true;
    send({ id: openRequestId, method: "ui/open-link", params: { url } });
  }

  function render(focusTab = false) {
    const plan = plans[selected];
    tabs.replaceChildren();
    tabs.hidden = plans.length < 2;
    panel.replaceChildren();
    panel.hidden = false;
    if (tabs.hidden) {
      panel.removeAttribute("role");
      panel.removeAttribute("aria-labelledby");
      panel.append(element("h2", plan.label));
    } else {
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", "plan-tab-" + selected);
      plans.forEach((entry, index) => {
        const tab = element("button", entry.label);
        tab.type = "button";
        tab.id = "plan-tab-" + index;
        tab.setAttribute("role", "tab");
        tab.setAttribute("aria-controls", panel.id);
        tab.setAttribute("aria-selected", String(index === selected));
        tab.tabIndex = index === selected ? 0 : -1;
        tab.addEventListener("click", () => { selected = index; render(true); });
        tab.addEventListener("keydown", event => {
          const direction = { ArrowLeft: -1, ArrowRight: 1, Home: -index, End: plans.length - 1 - index };
          if (!(event.key in direction)) return;
          event.preventDefault();
          selected = (index + direction[event.key] + plans.length) % plans.length;
          render(true);
        });
        tabs.append(tab);
      });
      if (focusTab) tabs.children[selected].focus();
    }

    const url = links[plan.id];
    if (url) {
      const button = element("button", "Open in EconPlanner ↗");
      button.id = "open-plan";
      button.type = "button";
      button.addEventListener("click", () => openPlan(url));
      const hint = element("p", "Edit your plan or download its PDF.");
      hint.className = "hint";
      openError = element("p", "The link could not be opened. Use the link in the chat reply.");
      openError.setAttribute("role", "status");
      openError.hidden = true;
      panel.append(button, hint, openError);
    }

    const table = element("table");
    table.setAttribute("aria-label", plan.label + " schedule");
    const header = table.createTHead().insertRow();
    for (const label of ["Term", "Courses"]) {
      const cell = element("th", label);
      cell.scope = "col";
      header.append(cell);
    }
    const body = table.createTBody();
    for (const term of plan.terms) {
      const row = body.insertRow();
      const heading = element("th", term.label);
      heading.scope = "row";
      row.append(heading);
      const cell = row.insertCell();
      if (term.studyAbroad) {
        cell.textContent = "Study abroad";
      } else if (!term.courses.length) {
        cell.textContent = "No Economics courses planned";
      } else {
        const courses = element("ul");
        for (const course of term.courses) {
          const name = [course.code, course.title].filter(Boolean).join(" · ");
          courses.append(element("li", name));
        }
        cell.append(courses);
      }
    }
    panel.append(table);
    section("Things to keep in mind", (plan.conditions || []).map(condition => condition.message).filter(Boolean));
    section("Ask your advisor", advisorContext || []);
  }

  window.addEventListener("message", event => {
    const message = event.data;
    if (event.source !== window.parent || message?.jsonrpc !== "2.0") return;
    if (message.id === 1 && message.result && !connected) {
      connected = true;
      send({ method: "ui/notifications/initialized" });
      const content = document.querySelector("main");
      new ResizeObserver(() => send({
        method: "ui/notifications/size-changed", params: { height: Math.ceil(content.getBoundingClientRect().height) }
      })).observe(content);
      return;
    }
    if (!connected) return;
    if (openRequestId !== undefined && message.id === openRequestId && openError) {
      openRequestId = undefined;
      openError.hidden = !message.error;
      return;
    }
    if (message.method !== "ui/notifications/tool-result") return;
    const result = message.params?.structuredContent || {};
    const card = message.params?._meta?.econplannerPlanCard;
    plans = result.plans || (result.plan ? [result.plan] : []);
    links = card?.links || {};
    advisorContext = result.studentAdvisorContext;
    selected = Math.max(0, plans.findIndex(plan => plan.id === card?.selectedPlanId));
    status.textContent = result.message || (plans.length ? "" : "No plan is available.");
    if (plans.length) {
      render();
    } else {
      tabs.hidden = true;
      panel.hidden = true;
    }
  });
  send({
    id: 1, method: "ui/initialize", params: {
      appInfo: { name: "EconPlanner plan card", version: "1.0.0" },
      appCapabilities: {},
      protocolVersion: "2026-01-26"
    }
  });
</script>
</body>
</html>`;
