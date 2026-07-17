export function canAccess(user, resource) {
  if (user) {
    if (user.active) {
      if (resource) {
        if (resource.visibility === "public") {
          return true;
        } else {
          if (user.roles) {
            if (user.roles.includes("admin")) {
              return true;
            } else {
              if (resource.ownerId === user.id) {
                if (resource.visibility === "private" || resource.visibility === "internal") {
                  return true;
                } else {
                  return false;
                }
              } else {
                if (resource.visibility === "internal") {
                  return user.roles.includes("member");
                } else {
                  return false;
                }
              }
            }
          } else {
            return false;
          }
        }
      } else {
        return false;
      }
    } else {
      return false;
    }
  } else {
    return false;
  }
}
