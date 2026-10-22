// words.mjs — the few labels the server writes itself: confirm options,
// fallback titles, screenshot captions, the desktop notification. They follow
// the language of the questions: `lang` in the spec, otherwise Russian when
// the question text has Cyrillic, otherwise English.

const WORDS = {
  en: {
    yes: "Yes",
    no: "No",
    change: "Yes, with changes",
    changeDetail: "Describe the changes in a note.",
    round: "Decisions needed",
    section: (n) => `Section ${n}`,
    question: "Question",
    option: (n) => `Option ${n}`,
    mobile: "Phone",
    desktop: "Desktop",
    ios: "iOS simulator",
    android: "Android emulator",
    newRound: (title) => `New questions: ${title}`,
    replied: (title) => `The agent answered your question: ${title}`,
    refilled: (title) => `New cards in ${title}`,
    brief: {
      goal: "Goal",
      confidence: (n) => `The agent's confidence: ${n}%`,
      kinds: { decision: "Decisions", risk: "Risks", problem: "Problems", open: "Open questions", note: "Notes" },
      answers: "Answers",
      skipped: "skipped",
      note: "The user's note",
    },
  },
  ru: {
    yes: "Да",
    no: "Нет",
    change: "Да, но с правками",
    changeDetail: "Опишите правки в заметке.",
    round: "Нужно принять решения",
    section: (n) => `Раздел ${n}`,
    question: "Вопрос",
    option: (n) => `Вариант ${n}`,
    mobile: "Телефон",
    desktop: "Компьютер",
    ios: "Симулятор iOS",
    android: "Эмулятор Android",
    newRound: (title) => `Новые вопросы: ${title}`,
    replied: (title) => `Агент ответил на ваш вопрос: ${title}`,
    refilled: (title) => `Новые карточки: ${title}`,
    brief: {
      goal: "Цель",
      confidence: (n) => `Уверенность агента: ${n}%`,
      kinds: { decision: "Решения", risk: "Риски", problem: "Проблемы", open: "Открытые вопросы", note: "Заметки" },
      answers: "Ответы",
      skipped: "пропущено",
      note: "Заметка пользователя",
    },
  },
};

export function specLang(raw) {
  const set = typeof raw?.lang === "string" ? raw.lang.trim().slice(0, 2).toLowerCase() : "";
  if (WORDS[set]) return set;
  const questions = Array.isArray(raw?.questions) ? raw.questions : [];
  const text = [raw?.title, raw?.intro, raw?.recap, ...questions.flatMap((q) => [q?.title, q?.question, q?.tldr])];
  return /[А-Яа-яЁё]/.test(text.filter((s) => typeof s === "string").join(" ")) ? "ru" : "en";
}

export const words = (lang) => WORDS[lang] || WORDS.en;
