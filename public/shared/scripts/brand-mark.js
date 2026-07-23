(function (global) {
    const BRAND_MARK_CYCLE_DUR = '2.8s';
    const BRAND_MARK_PULSE_PATH =
        'M96 268 L168 268 L208 168 L256 332 L304 204 L352 268 L416 268';

    const EASE_HOLD = '0 0 1 1';

    /** Sweep window - slow holds fixed; draw compressed into the middle. */
    const SWEEP_START = 0.05;
    const SWEEP_SLOW_IN_END = 0.11;
    const SWEEP_FAST_END = 0.29;
    const SWEEP_END = 0.4;
    const FADE_START = 0.82;
    const FADE_MID_A = 0.94;
    const FADE_MID_B = 0.96;
    const CYCLE_END = 1;

    const PATH_DASH_VALUES = '520;520;520;0;0;0;-520;-520;520';
    const PATH_DASH_TIMES = [
        0,
        SWEEP_START,
        SWEEP_SLOW_IN_END,
        SWEEP_FAST_END,
        SWEEP_END,
        FADE_START,
        FADE_MID_A,
        FADE_MID_B,
        CYCLE_END,
    ].join(';');
    const PATH_DASH_SPLINES = Array(8).fill(EASE_HOLD).join('; ');

    const PATH_OPACITY_VALUES = '0;1;1;1;1;1;0;0;0';
    const PATH_OPACITY_TIMES = PATH_DASH_TIMES;
    const PATH_OPACITY_SPLINES = PATH_DASH_SPLINES;

    const LEAD_MOTION_POINTS = '0;0;0;0;1;1;1;1';
    const LEAD_MOTION_TIMES = [
        0,
        SWEEP_START,
        SWEEP_SLOW_IN_END,
        SWEEP_SLOW_IN_END,
        SWEEP_FAST_END,
        SWEEP_END,
        FADE_MID_B,
        CYCLE_END,
    ].join(';');
    const LEAD_MOTION_SPLINES = Array(7).fill(EASE_HOLD).join('; ');

    const LEAD_OPACITY_VALUES = '0;0;0;0;1;0;0;0';
    const LEAD_OPACITY_TIMES = LEAD_MOTION_TIMES;
    const LEAD_OPACITY_SPLINES = LEAD_MOTION_SPLINES;

    const TRAIL_SLOW_IN = 0.18;
    const TRAIL_SLOW_IN_END = 0.24;
    const TRAIL_FAST_END = 0.42;
    const TRAIL_HOLD_END = 0.78;

    const TRAIL_MOTION_POINTS = '0;0;0;0;1;1;1;1';
    const TRAIL_MOTION_TIMES = [
        0,
        TRAIL_SLOW_IN,
        TRAIL_SLOW_IN_END,
        TRAIL_SLOW_IN_END,
        TRAIL_FAST_END,
        TRAIL_HOLD_END,
        FADE_MID_B,
        CYCLE_END,
    ].join(';');
    const TRAIL_MOTION_SPLINES = Array(7).fill(EASE_HOLD).join('; ');

    const TRAIL_OPACITY_VALUES = '0;0;0;0;1;0;0;0';
    const TRAIL_OPACITY_TIMES = TRAIL_MOTION_TIMES;
    const TRAIL_OPACITY_SPLINES = TRAIL_MOTION_SPLINES;

    function svg(uid) {
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" class="brand-mark" aria-hidden="true">
  <defs>
    <linearGradient id="${uid}-purple" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#e040fb"/>
      <stop offset="100%" stop-color="#702082"/>
    </linearGradient>
  </defs>
  <circle class="brand-mark-ring--outer" cx="256" cy="256" r="178" fill="none" stroke="#702082" stroke-width="12" opacity="0.45"/>
  <circle class="brand-mark-ring--inner" cx="256" cy="256" r="142" fill="none" stroke="url(#${uid}-purple)" stroke-width="6" opacity="0.65"/>
  <path
    id="${uid}-pulse-path"
    class="brand-mark-pulse"
    fill="none"
    stroke="#ffc72c"
    stroke-width="14"
    stroke-linecap="round"
    stroke-linejoin="round"
    pathLength="520"
    stroke-dasharray="520"
    stroke-dashoffset="520"
    opacity="0"
    d="${BRAND_MARK_PULSE_PATH}"
  >
    <animate class="brand-mark-cycle-anim" attributeName="stroke-dashoffset" dur="${BRAND_MARK_CYCLE_DUR}" repeatCount="indefinite" calcMode="spline"
      values="${PATH_DASH_VALUES}" keyTimes="${PATH_DASH_TIMES}" keySplines="${PATH_DASH_SPLINES}"/>
    <animate class="brand-mark-cycle-anim" attributeName="opacity" dur="${BRAND_MARK_CYCLE_DUR}" repeatCount="indefinite" calcMode="spline"
      values="${PATH_OPACITY_VALUES}" keyTimes="${PATH_OPACITY_TIMES}" keySplines="${PATH_OPACITY_SPLINES}"/>
  </path>
  <circle class="brand-mark-dot--trail" r="11" fill="#ff4081" opacity="0">
    <animate class="brand-mark-cycle-anim" attributeName="opacity" dur="${BRAND_MARK_CYCLE_DUR}" repeatCount="indefinite" calcMode="spline"
      values="${TRAIL_OPACITY_VALUES}" keyTimes="${TRAIL_OPACITY_TIMES}" keySplines="${TRAIL_OPACITY_SPLINES}"/>
    <animateMotion class="brand-mark-cycle-anim" dur="${BRAND_MARK_CYCLE_DUR}" repeatCount="indefinite" calcMode="spline"
      keyTimes="${TRAIL_MOTION_TIMES}" keyPoints="${TRAIL_MOTION_POINTS}" keySplines="${TRAIL_MOTION_SPLINES}">
      <mpath href="#${uid}-pulse-path"/>
    </animateMotion>
  </circle>
  <circle class="brand-mark-dot--lead" r="16" fill="#ffc72c" opacity="0">
    <animate class="brand-mark-cycle-anim" attributeName="opacity" dur="${BRAND_MARK_CYCLE_DUR}" repeatCount="indefinite" calcMode="spline"
      values="${LEAD_OPACITY_VALUES}" keyTimes="${LEAD_OPACITY_TIMES}" keySplines="${LEAD_OPACITY_SPLINES}"/>
    <animateMotion class="brand-mark-cycle-anim" dur="${BRAND_MARK_CYCLE_DUR}" repeatCount="indefinite" calcMode="spline"
      keyTimes="${LEAD_MOTION_TIMES}" keyPoints="${LEAD_MOTION_POINTS}" keySplines="${LEAD_MOTION_SPLINES}">
      <mpath href="#${uid}-pulse-path"/>
    </animateMotion>
  </circle>
</svg>`;
    }

    function mount(hostId, uid) {
        const host = typeof hostId === 'string' ? document.getElementById(hostId) : hostId;
        if (!host) return;
        host.innerHTML = svg(uid);
    }

    function setBusy(busy) {
        document.querySelectorAll('.brand-mark').forEach((mark) => {
            mark.classList.toggle('brand-mark--busy', busy);
        });
    }

    global.TbaBrandMark = { svg, mount, setBusy };
})(typeof window !== 'undefined' ? window : globalThis);
