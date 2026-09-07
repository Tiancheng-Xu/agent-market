export function shouldRequireCocosReady(value) {
  return value !== "0";
}

export function isCocosGateFailure({ route, ready, required }) {
  return required && route === "/office" && !ready;
}
