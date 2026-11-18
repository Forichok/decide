import { t } from "./i18n.js";

export function reviewerRoleDisplay(role, defaultRoles) {
  const original = defaultRoles.find(({ id }) => id === role.id);
  return {
    title: original && role.title === original.title ? t(`settings4.role.${role.id}.title`) : role.title,
    brief: original && role.brief === original.brief ? t(`settings4.role.${role.id}.brief`) : role.brief,
  };
}
