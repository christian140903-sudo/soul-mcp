import { AppError } from "../errors.mjs";

export function readUser(store, id) {
  const user = store.get(id);
  if (!user) {
    throw new Error("user not found");
  }
  return user;
}

export function saveUser(store, user) {
  if (typeof user.name !== "string" || user.name === "") {
    throw new AppError("SAVE_FAILED", "user name is missing", { field: "name" });
  }
  store.set(user.id, user);
  return user;
}

export function deleteUser(store, id) {
  if (!store.has(id)) {
    throw new AppError("USER_NOT_FOUND", "cannot delete user " + id, {});
  }
  store.delete(id);
}
