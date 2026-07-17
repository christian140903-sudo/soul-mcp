function assertEntityCore(input) {
  if (typeof input.id !== "string" || input.id.trim() === "") {
    throw new Error("invalid entity: id must be a non-empty string");
  }
  if (!Number.isInteger(input.revision) || input.revision < 0) {
    throw new Error("invalid entity: revision must be a non-negative integer");
  }
}

export function validateUser(input) {
  assertEntityCore(input);
  if (typeof input.email !== "string" || !input.email.includes("@")) {
    throw new Error("invalid user: email must contain @");
  }
  return true;
}

export function validateOrder(input) {
  assertEntityCore(input);
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new Error("invalid order: items must be a non-empty list");
  }
  return true;
}

export function validateProduct(input) {
  assertEntityCore(input);
  if (typeof input.price !== "number" || input.price < 0) {
    throw new Error("invalid product: price must be a non-negative number");
  }
  return true;
}
