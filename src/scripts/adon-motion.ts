/** Selected Adon motion vocabulary, adapted without template-wide DOM assumptions.
 * Native scrolling and visible HTML are the baseline. The two vendored GSAP files
 * load only on public marketing pages; no animation is required to use the app.
 */
type MotionWindow = Window &
  typeof globalThis & { gsap?: any; ScrollTrigger?: any };
const motionWindow = window as MotionWindow;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => resolve();
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

const topButton = document.querySelector<HTMLButtonElement>("[data-adon-top]");
if (topButton) {
  const refreshProgress = () => {
    topButton.hidden = window.scrollY < 500;
    const height = document.documentElement.scrollHeight - window.innerHeight;
    topButton.style.setProperty(
      "--scroll-progress",
      `${height > 0 ? Math.min(100, (window.scrollY / height) * 100) : 0}%`,
    );
  };
  window.addEventListener("scroll", refreshProgress, { passive: true });
  topButton.addEventListener("click", () =>
    window.scrollTo({
      top: 0,
      behavior: reducedMotion.matches ? "instant" : "smooth",
    }),
  );
  refreshProgress();
}

async function initAdonMotion() {
  if (
    document.body.classList.contains("adon-workspace") ||
    document.body.classList.contains("adon-auth")
  )
    return;
  const toggle = document.querySelector<HTMLButtonElement>(
    ".adon-motion-toggle",
  );
  let paused = false;
  let context: any;
  const update = () => {
    context?.revert();
    document.documentElement.classList.toggle(
      "adon-motion-paused",
      paused || reducedMotion.matches,
    );
    if (
      paused ||
      reducedMotion.matches ||
      !motionWindow.gsap ||
      !motionWindow.ScrollTrigger
    )
      return;
    const gsap = motionWindow.gsap;
    const ScrollTrigger = motionWindow.ScrollTrigger;
    gsap.registerPlugin(ScrollTrigger);
    context = gsap.context(() => {
      // The original word/line reveal, preserving readable semantic headings.
      document
        .querySelectorAll<HTMLElement>("[data-adon-title], .section__head h1")
        .forEach((title) => {
          const lines = title.querySelectorAll(".adon-line");
          gsap.from(lines.length ? lines : title, {
            y: 32,
            opacity: 0,
            rotationX: -35,
            transformOrigin: "top center",
            duration: 0.9,
            stagger: 0.12,
            ease: "power3.out",
            clearProps: "all",
            scrollTrigger: { trigger: title, start: "top 94%", once: true },
          });
        });
      document
        .querySelectorAll<HTMLElement>("[data-adon-reveal], .plan-grid .plan")
        .forEach((item) => {
          gsap.from(item, {
            y: 38,
            opacity: 0,
            duration: 0.85,
            ease: "power2.out",
            clearProps: "all",
            scrollTrigger: { trigger: item, start: "top 95%", once: true },
          });
        });
      document
        .querySelectorAll<HTMLElement>("[data-adon-count]")
        .forEach((item) => {
          const end = Number(item.dataset.adonCount);
          const counter = { value: 0 };
          gsap.to(counter, {
            value: end,
            duration: 1.25,
            ease: "power2.out",
            scrollTrigger: { trigger: item, start: "top 95%", once: true },
            onUpdate: () => {
              item.textContent = String(Math.round(counter.value));
            },
            onComplete: () => {
              item.textContent = String(end);
            },
          });
        });
      const desktop = gsap.matchMedia();
      desktop.add("(min-width: 900px)", () => {
        document
          .querySelectorAll<HTMLElement>("[data-adon-parallax]")
          .forEach((item) => {
            gsap.fromTo(
              item,
              { y: 16 },
              {
                y: -16,
                ease: "none",
                scrollTrigger: {
                  trigger: item.parentElement,
                  start: "top bottom",
                  end: "bottom top",
                  scrub: 0.7,
                },
              },
            );
          });
        const heading = document.querySelector(".adon-work-heading h2");
        if (heading)
          gsap.fromTo(
            heading,
            { x: -20 },
            {
              x: 20,
              ease: "none",
              scrollTrigger: {
                trigger: heading,
                start: "top bottom",
                end: "bottom top",
                scrub: 1,
              },
            },
          );
      });
    });
    document.fonts.ready.then(() => ScrollTrigger.refresh());
  };
  toggle?.addEventListener("click", () => {
    paused = !paused;
    toggle.setAttribute("aria-pressed", String(paused));
    toggle.textContent = paused ? "Resume motion" : "Pause motion";
    update();
    // Restore counters if motion was cancelled during the count-up.
    document
      .querySelectorAll<HTMLElement>("[data-adon-count]")
      .forEach((item) => {
        item.textContent = item.dataset.adonCount!;
      });
  });
  if (toggle) toggle.hidden = reducedMotion.matches;
  reducedMotion.addEventListener("change", () => {
    if (toggle) toggle.hidden = reducedMotion.matches;
    update();
    document
      .querySelectorAll<HTMLElement>("[data-adon-count]")
      .forEach((item) => {
        item.textContent = item.dataset.adonCount!;
      });
  });
  try {
    await loadScript("/vendor/adon/js/gsap.min.js");
    await loadScript("/vendor/adon/js/ScrollTrigger.min.js");
    update();
  } catch {
    // Content, links, accordions, and native scrolling remain available.
  }
}
void initAdonMotion();
