// Aggregate term coverage cannot establish absence outside reviewed scopes.
export function scheduleCoverageForCourse(term, course) {
  const code = String(course || "").trim().toUpperCase();
  const scopes = term?.coverageScopes || [];
  const scope = scopes.find(item => item.course === code)
    || scopes.find(item => item.subject === code.split(" ")[0]);
  return { coverage: scope?.coverage || "UNKNOWN", sourceRefs: scope?.sourceRefs || [], scope: scope || null };
}
