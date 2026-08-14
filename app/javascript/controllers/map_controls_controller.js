import { Controller } from "@hotwired/stimulus"

export default class extends Controller {
  static targets = ["panel", "toggleIcon", "label"]
  static values = { date: String }

  connect() {
    // Restore panel state from sessionStorage on page load — desktop only.
    // On phones the panel isn't toggled from the pill anymore (the pill opens
    // the Timeline sheet), so a restored-open panel would have no way closed.
    const panelState = sessionStorage.getItem("mapControlsPanelState")
    if (panelState === "visible" && window.matchMedia("(min-width: 1024px)").matches) {
      this.showPanel()
    }

    // Keep the pill label + stored day in sync with SPA day changes coming
    // from the Timeline calendar / day-nav (which pushState and refetch the
    // map without a server render — the label used to silently go stale,
    // showing e.g. "10 August" over an August 1 selection).
    this.boundDaySync = (e) => {
      const date = e.detail?.date
      if (date) this.applyDay(date)
    }
    document.addEventListener("timeline-feed:date-navigated", this.boundDaySync)
    document.addEventListener("timeline-feed:day-selected", this.boundDaySync)
  }

  disconnect() {
    if (this.boundDaySync) {
      document.removeEventListener(
        "timeline-feed:date-navigated",
        this.boundDaySync,
      )
      document.removeEventListener(
        "timeline-feed:day-selected",
        this.boundDaySync,
      )
      this.boundDaySync = null
    }
  }

  // ---------- Day stepping (mobile pill arrows) ----------

  prevDay() {
    this.stepDay(-1)
  }

  nextDay() {
    this.stepDay(1)
  }

  goToday() {
    // Local today, not UTC — near midnight toISOString() lands on the wrong day.
    const now = new Date()
    const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
    this.navigateToDay(iso)
  }

  stepDay(delta) {
    const current = this.currentDay()
    if (!current) return
    // UTC math so ±1 day never drifts across timezones (same convention as
    // timeline_feed#navigateDay).
    const [y, m, d] = current.split("-").map(Number)
    const date = new Date(Date.UTC(y, m - 1, d))
    date.setUTCDate(date.getUTCDate() + delta)
    this.navigateToDay(date.toISOString().slice(0, 10))
  }

  // The day the arrows step FROM: explicit ?date= (set by SPA nav), else the
  // range's end date from the URL, else the server-rendered value.
  currentDay() {
    const params = new URLSearchParams(window.location.search)
    const explicit = params.get("date")
    if (explicit) return explicit
    const endAt = params.get("end_at")
    if (endAt && /^\d{4}-\d{2}-\d{2}/.test(endAt)) return endAt.slice(0, 10)
    return this.dateValue || null
  }

  // Route through the Timeline controller's SPA path when it's on the page —
  // map layers refetch in place AND fit bounds to the day's data, the
  // calendar's blue selection follows, URL updates via pushState. Falls back
  // to a full navigation if the timeline panel isn't rendered.
  navigateToDay(date) {
    const el = document.querySelector('[data-controller~="timeline-feed"]')
    const tf =
      el &&
      this.application.getControllerForElementAndIdentifier(
        el,
        "timeline-feed",
      )
    if (tf?.navigateToDay) {
      tf.navigateToDay(date)
      this.applyDay(date)
      return
    }
    window.location.assign(
      `/map?start_at=${date}T00:00:00&end_at=${date}T23:59:59&date=${date}`,
    )
  }

  applyDay(date) {
    this.dateValue = date
    if (this.hasLabelTarget) {
      const [y, m, d] = date.split("-").map(Number)
      const dt = new Date(Date.UTC(y, m - 1, d))
      // Mirrors the server's human_date: "10 August 2026"
      this.labelTarget.textContent = `${d} ${dt.toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" })} ${y}`
    }
  }

  toggle() {
    const isHidden = this.panelTarget.classList.contains("hidden")

    if (isHidden) {
      this.showPanel()
      sessionStorage.setItem("mapControlsPanelState", "visible")
    } else {
      this.hidePanel()
      sessionStorage.setItem("mapControlsPanelState", "hidden")
    }
  }

  // Tapping the pill's date opens the Timeline sheet — the calendar there is
  // the date picker now, so the pill needs no chevron-down/dropdown of its own.
  openTimeline() {
    const cluster = document.querySelector('[data-controller~="map-panel"]')
    const mp =
      cluster &&
      this.application.getControllerForElementAndIdentifier(
        cluster,
        "map-panel",
      )
    if (mp?.openTabByName) mp.openTabByName("timeline-feed")
  }

  showPanel() {
    this.panelTarget.classList.remove("hidden")

    // Update icon to chevron-up (the icon only exists on layouts that still
    // render a dropdown toggle).
    const currentIcon = this.hasToggleIconTarget && this.toggleIconTarget.querySelector("svg")
    if (currentIcon) {
      currentIcon.classList.remove("lucide-chevron-down")
      currentIcon.classList.add("lucide-chevron-up")
      currentIcon.innerHTML = '<path d="m18 15-6-6-6 6"/>'
    }
  }

  hidePanel() {
    this.panelTarget.classList.add("hidden")

    // Update icon to chevron-down
    const currentIcon = this.hasToggleIconTarget && this.toggleIconTarget.querySelector("svg")
    if (currentIcon) {
      currentIcon.classList.remove("lucide-chevron-up")
      currentIcon.classList.add("lucide-chevron-down")
      currentIcon.innerHTML = '<path d="m6 9 6 6 6-6"/>'
    }
  }
}
