export function serializeEvent(event) {
  return {
    id: event.id,
    created: event.created,
    kind: event.kind
  };
}

export function serializeBatch(events) {
  return { events: events.map(serializeEvent), count: events.length };
}
