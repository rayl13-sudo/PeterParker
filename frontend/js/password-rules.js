// Password requirements, shared by sign-up and settings.
// Keep in sync with check_password_strength in backend/app/api/routes/auth.py.
export const PASSWORD_RULES = {
  length: (pw) => pw.length >= 8,
  capital: (pw) => /[A-Z]/.test(pw),
  special: (pw) => /[^A-Za-z0-9\s]/.test(pw),
};

export function passwordMeetsRules(pw) {
  return Object.values(PASSWORD_RULES).every((rule) => rule(pw));
}

// Ticks each <li data-rule="..."> in `list` as `input` meets it. Returns an
// update function to call after resetting the input.
export function bindRuleChecklist(input, list) {
  const items = list.querySelectorAll("[data-rule]");
  items.forEach((li) => li.setAttribute("role", "checkbox"));
  const update = () => {
    items.forEach((li) => {
      const met = PASSWORD_RULES[li.dataset.rule](input.value);
      li.classList.toggle("met", met);
      li.setAttribute("aria-checked", String(met));
    });
  };
  input.addEventListener("input", update);
  update();
  return update;
}
