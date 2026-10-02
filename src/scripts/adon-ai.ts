/** AI Agency interactions, with native overflow and readable no-JS panels. */
for (const root of document.querySelectorAll<HTMLElement>("[data-ai-tabs]")) {
  const tabs = [...root.querySelectorAll<HTMLButtonElement>("[data-ai-tab]")];
  const panels = [...root.querySelectorAll<HTMLElement>("[data-ai-panel]")];
  root.querySelector(".ai-tab-list")?.setAttribute("role", "tablist");
  const select = (index: number, focus = false) => {
    tabs.forEach((tab, i) => {
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
    });
    panels.forEach((panel, i) => {
      panel.setAttribute("role", "tabpanel");
      panel.hidden = i !== index;
      panel.tabIndex = 0;
    });
    if (focus) tabs[index].focus();
  };
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => select(index));
    tab.addEventListener("keydown", (event) => {
      let next = index;
      if (["ArrowRight", "ArrowDown"].includes(event.key))
        next = (index + 1) % tabs.length;
      else if (["ArrowLeft", "ArrowUp"].includes(event.key))
        next = (index + tabs.length - 1) % tabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      else return;
      event.preventDefault();
      select(next, true);
    });
  });
  select(0);
}
const gallery = document.querySelector<HTMLElement>("[data-ai-gallery]");
for (const [selector, direction] of [
  ["[data-ai-prev]", -1],
  ["[data-ai-next]", 1],
] as const) {
  document.querySelector(selector)?.addEventListener("click", () => {
    if (!gallery) return;
    const card = gallery.querySelector<HTMLElement>(".ai-gallery-card");
    gallery.scrollBy({
      left: direction * ((card?.offsetWidth ?? 300) + 25),
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
  });
}
const cubes = document.querySelector<HTMLElement>("[data-ai-cubes]");
if (cubes) {
  const images = cubes.querySelectorAll<HTMLElement>("img");
  const reset = () =>
    images.forEach((image) => {
      image.style.transform = "";
    });
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  cubes.addEventListener("pointermove", (event) => {
    if (
      event.pointerType !== "mouse" ||
      reduced.matches ||
      document.documentElement.classList.contains("adon-motion-paused")
    ) {
      reset();
      return;
    }
    const rect = cubes.getBoundingClientRect();
    images.forEach((image, index) => {
      const depth = 15 + index * 7;
      image.style.transform = `translate(${((event.clientX - rect.left) / rect.width - 0.5) * depth}px,${((event.clientY - rect.top) / rect.height - 0.5) * depth}px)`;
    });
  });
  cubes.addEventListener("pointerleave", reset);
  reduced.addEventListener("change", reset);
  document
    .querySelector(".adon-motion-toggle")
    ?.addEventListener("click", reset);
}
