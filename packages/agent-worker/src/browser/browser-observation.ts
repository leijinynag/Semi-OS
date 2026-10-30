/** 在页面内执行的只读快照。必须自包含，Ego CLI 会序列化此函数到页面。 */
export function collectBrowserObservation() {
  const text = document.body?.innerText ?? "";
  const elements = Array.from(
    document.querySelectorAll("a,button,input,textarea,[role=button],[role=link],[role=searchbox]"),
  )
    .filter((node) => {
      const box = node.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    })
    .slice(0, 60)
    .map((node) => {
      const el = node as HTMLInputElement;
      const role =
        el.getAttribute("role") ??
        (el.tagName === "A"
          ? "link"
          : el.tagName === "BUTTON" || ["submit", "button", "reset"].includes(el.type)
            ? "button"
            : el.type === "search"
              ? "searchbox"
              : el.tagName === "TEXTAREA" ||
                  (el.tagName === "INPUT" && ["text", "email", "url", "tel", ""].includes(el.type))
                ? "textbox"
                : "");
      const labelled = el
        .getAttribute("aria-labelledby")
        ?.split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
      const name =
        labelled ||
        el.getAttribute("aria-label") ||
        el.labels?.[0]?.innerText ||
        el.innerText ||
        (role === "button" ? el.value : "") ||
        el.placeholder ||
        "";
      const form = el.closest("form");
      const searchControl =
        ["textbox", "searchbox"].includes(role) ||
        (role === "button" && /^(?:搜索|查找|search|find)$/i.test(name.trim()));
      const searchAction = form
        ? new URL(el.getAttribute("formaction") || form.action || location.href, location.href).href
        : undefined;
      const method = el.getAttribute("formmethod") || form?.method || "get";
      return {
        role,
        name: name.trim(),
        placeholder: el.placeholder,
        labelled: !!(labelled || el.getAttribute("aria-label") || el.labels?.length),
        href: el.tagName === "A" ? (el as unknown as HTMLAnchorElement).href : undefined,
        search:
          searchControl &&
          !!form &&
          method.toLowerCase() === "get" &&
          (!!el.closest('[role="search"]') ||
            el.type === "search" ||
            /(?:^|\/)search(?:\/|$)/i.test(new URL(searchAction!).pathname)),
        searchAction,
        value: el.value ?? "",
        unsupported:
          el.hasAttribute("download") ||
          el.getAttribute("target") === "_blank" ||
          el.type === "file",
      };
    });
  const article = document.querySelector<HTMLElement>("article, main, [role=main]");
  return {
    text,
    content: (article?.innerText ?? text).trim(),
    elements,
    title: document.title,
    url: location.href,
  };
}

export type BrowserPageData = ReturnType<typeof collectBrowserObservation>;
