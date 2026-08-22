import worker from "../apps/web/dist/_worker.js";

export function onRequest(context) {
  return worker.fetch(context.request, context.env);
}
