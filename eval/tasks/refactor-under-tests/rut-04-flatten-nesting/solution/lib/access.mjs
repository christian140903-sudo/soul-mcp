export function canAccess(user, resource) {
  if (!user || !user.active || !resource) {
    return false;
  }
  if (resource.visibility === "public") {
    return true;
  }
  if (!user.roles) {
    return false;
  }
  if (user.roles.includes("admin")) {
    return true;
  }
  if (resource.ownerId === user.id) {
    return resource.visibility === "private" || resource.visibility === "internal";
  }
  if (resource.visibility === "internal") {
    return user.roles.includes("member");
  }
  return false;
}
