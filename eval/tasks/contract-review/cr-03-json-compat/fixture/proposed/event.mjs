export function serializeEvent(event) {
  return {
    id: String(event.id),
    createdAt: event.created,
    kind: event.kind,
    tags: event.tags ?? []
  };
}

export function serializeBatch(events) {
  return { events: events.map(serializeEvent), count: events.length };
}
