/**
 * Custom profile evidence order. The applied vault and Features shots record
 * the plan `finishCustom` left. Core item types turn on only after those shots.
 */

export function customProfileEvidenceSteps(enableCoreCount) {
  const steps = ["applied", "features"];
  if (enableCoreCount > 0) steps.push("enable-core");
  return steps;
}

export function shotsPrecedeCoreRemediation(steps) {
  const enable = steps.indexOf("enable-core");
  if (enable < 0) return true;
  const applied = steps.indexOf("applied");
  const features = steps.indexOf("features");
  return applied >= 0 && features >= 0 && applied < enable && features < enable;
}
