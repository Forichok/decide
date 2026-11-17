// Overview risks are a page projection; the submitted spec and digest stay as written.
export function collectRisks(spec, chapters) {
  const risks = [...spec.risks];
  for (const chapter of chapters) chapter.focus.forEach((place, index) => {
    if (place.kind !== "risk") return;
    const at = `${place.file}:${place.from}${place.to !== place.from ? `-${place.to}` : ""}`;
    const listed = risks.some((r) => r.chapter === chapter.id && (r.place === index || r.at === at));
    if (!listed) risks.push({ level: "high", what: place.note, chapter: chapter.id, place: index });
  });
  return risks;
}
