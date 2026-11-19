/**
 * Rising Tides: CMIP6 Regional Sea Level Projections
 * DSC 106 Final Project
 * D3.js v7 + TopoJSON + Scrollama.js
 */

(function () {
  "use strict";

  // ========================================================
  // 1. APPLICATION STATE
  // ========================================================
  const state = {
    region: "global",
    scenario: "ssp126", // 'ssp126' (Low) or 'ssp585' (High)
    year: 2100,         // 2050 or 2100
    showDifference: false,
    isAnimating: false,
    worldData: null,
    scenarioData: null,
    oceanData: null
  };

  // ========================================================
  // 2. D3 & SVG SETUP
  // ========================================================
  const container = document.getElementById("map-container");
  let width = container.clientWidth || window.innerWidth;
  let height = container.clientHeight || window.innerHeight;

  const svg = d3.select("#sea-level-map")
    .attr("width", width)
    .attr("height", height)
    .attr("viewBox", [0, 0, width, height]);

  // Equirectangular (Plate Carrée) projection matching the CMIP6 climate proposal notebook.
  // Perfectly fits the 2:1 global aspect ratio [-180, 180] x [-90, 90] with zero vertical distortion or cropping.
  const calcBaseScale = () => Math.min(width / (2 * Math.PI), height / Math.PI) * 0.96;
  const initialBaseScale = calcBaseScale();

  const projection = d3.geoEquirectangular()
    .center([0, 0])
    .scale(initialBaseScale)
    .translate([width / 2, height / 2]);

  const pathGenerator = d3.geoPath().projection(projection);

  // Classic Scientific Blue-White-Red (RdBu_r) colormap matching matplotlib / ColorBrewer
  // Strictly symmetric domain centered on 0 cm (-35 cm to +35 cm)
  const oceanColorScale = d3.scaleLinear()
    .domain([-35, -24, -14, -6, -2, 0, 2, 6, 14, 24, 35])
    .range([
      "#053061", // Deep Navy Blue (<= -35 cm)
      "#2166ac", // Rich Cobalt Blue (-24 cm)
      "#4393c3", // Medium Steel Blue (-14 cm)
      "#92c5de", // Light Sky Blue (-6 cm)
      "#d1e5f0", // Very Pale Ice Blue (-2 cm)
      "#ffffff", // Pure White Baseline (0 cm)
      "#fddbc7", // Very Pale Peach (+2 cm)
      "#f4a582", // Coral Pink (+6 cm)
      "#d6604d", // Medium Coral Red (+14 cm)
      "#b2182b", // Crimson Red (+24 cm)
      "#67001f"  // Dark Maroon (>= +35 cm)
    ])
    .clamp(true);

  // SVG Defs for smooth continuous ocean scalar field (anti-aliased heatmap filter)
  const defs = svg.append("defs");
  const oceanFilter = defs.append("filter")
    .attr("id", "ocean-smooth-filter")
    .attr("x", "-20%")
    .attr("y", "-20%")
    .attr("width", "140%")
    .attr("height", "140%");

  oceanFilter.append("feGaussianBlur")
    .attr("stdDeviation", 1.8)
    .attr("result", "blur");

  // SVG Layer Groups (in precise z-index order)
  const gSphere = svg.append("g").attr("class", "layer-sphere");

  // GPU-accelerated Zoom Group containing all projected geographic elements
  const gZoom = svg.append("g").attr("class", "layer-zoom");
  const gGraticule = gZoom.append("g").attr("class", "layer-graticule");
  const gOcean = gZoom.append("g")
    .attr("class", "layer-ocean")
    .attr("filter", "url(#ocean-smooth-filter)");
  const gLand = gZoom.append("g").attr("class", "layer-land");

  // Sphere ocean background & Graticules
  gSphere.append("rect")
    .attr("class", "sphere-bg")
    .attr("width", width)
    .attr("height", height);

  const graticule = d3.geoGraticule();
  gGraticule.append("path")
    .datum(graticule)
    .attr("class", "graticule")
    .attr("d", pathGenerator);

  // ========================================================
  // 3. DATA LOADING & INITIALIZATION
  // ========================================================
  async function init() {
    try {
      const [world, scenarios, ocean] = await Promise.all([
        d3.json("data/world-50m.json").catch(() => d3.json("https://unpkg.com/world-atlas@2/countries-50m.json")),
        d3.json("data/scenarios.json"),
        d3.json("data/ocean_grid.json")
      ]);

      state.worldData = world;
      state.scenarioData = scenarios;
      state.oceanData = ocean;

      renderBaseMap();
      renderOceanGrid();
      updateMetricBar();
      handleResize();

      initScrollama();
      initUIControls();

      window.addEventListener("resize", debounce(handleResize, 200));
    } catch (err) {
      console.error("Initialization error loading datasets:", err);
    }
  }

  // ========================================================
  // 4. RENDERING FUNCTIONS
  // ========================================================

  function renderBaseMap() {
    const countries = topojson.feature(state.worldData, state.worldData.objects.countries);

    gLand.selectAll(".country-land")
      .data(countries.features)
      .join("path")
      .attr("class", "country-land")
      .attr("d", pathGenerator);
  }

  function renderOceanGrid() {
    const key = `${state.scenario}_${state.year}`;

    gOcean.selectAll(".ocean-cell")
      .data(state.oceanData.features)
      .join("path")
      .attr("class", "ocean-cell")
      .attr("d", pathGenerator)
      .style("fill", d => oceanColorScale(d.properties[key] ?? 0));
  }



  // ========================================================
  // 5. CAMERA & REGION ZOOM TRANSITIONS (GPU Accelerated)
  // ========================================================
  function transitionToRegion(regionId, immediate = false) {
    state.region = regionId;
    const reg = state.scenarioData.regions[regionId];
    if (!reg) return;

    // Calculate dynamic scale relative to viewport dimensions
    const baseScale = calcBaseScale();
    const targetScale = (reg.scale / 160) * baseScale;
    const k = targetScale / baseScale;
    const [targetLon, targetLat] = reg.center;

    // Direct 2D affine transform for Equirectangular projection:
    // Centers target [lon, lat] precisely at [width/2, height/2] with magnification k
    const tx = (width / 2) * (1 - k) - k * baseScale * (Math.PI / 180) * targetLon;
    const ty = (height / 2) * (1 - k) + k * baseScale * (Math.PI / 180) * targetLat;

    if (immediate) {
      gZoom.interrupt("camera-pan")
        .attr("transform", `translate(${tx}, ${ty}) scale(${k})`);
    } else {
      gZoom.transition("camera-pan")
        .duration(1100)
        .ease(d3.easeCubicInOut)
        .attr("transform", `translate(${tx}, ${ty}) scale(${k})`);
    }

    updateMetricBar(true);
  }

  // ========================================================
  // 6. SCENARIO / YEAR TRANSITION & ROLLING NUMBERS
  // ========================================================
  function updateDataViews(animated = false) {
    const key = `${state.scenario}_${state.year}`;

    // Direct synchronous style update:
    // Sets CSS inline style property 'fill', triggering GPU hardware-accelerated CSS transition
    gOcean.selectAll(".ocean-cell")
      .style("fill", d => {
        if (state.showDifference) {
          const delta = (d.properties[`ssp585_${state.year}`] ?? 0) - (d.properties[`ssp126_${state.year}`] ?? 0);
          return oceanColorScale(delta);
        }
        return oceanColorScale(d.properties[key] ?? 0);
      });

    // Update Metric Bar with Rolling Numbers
    updateMetricBar(animated);
  }

  function updateMetricBar(animated = false) {
    const reg = state.scenarioData.regions[state.region];
    if (!reg) return;

    const elRegion = document.getElementById("metric-region");
    const elRiseCm = document.getElementById("metric-rise-cm");
    const elRiseIn = document.getElementById("metric-rise-in");
    const elDiffCm = document.getElementById("metric-diff-cm");
    const elDiffIn = document.getElementById("metric-diff-in");
    const elVulnPill = document.getElementById("metric-vuln-pill");
    const elVulnScore = document.getElementById("metric-vuln-score");

    elRegion.textContent = reg.name;

    const lowMetrics = reg.metrics.ssp126[state.year] || reg.metrics.ssp126["2100"];
    const highMetrics = reg.metrics.ssp585[state.year] || reg.metrics.ssp585["2100"];

    // Scenario Divergence (Delta = SSP5-8.5 minus SSP1-2.6)
    const diffValCm = highMetrics.rise_cm - lowMetrics.rise_cm;
    const diffValIn = diffValCm / 2.54;

    let targetRiseCm, targetRiseIn;

    if (state.showDifference) {
      targetRiseCm = diffValCm;
      targetRiseIn = diffValIn;
      elVulnPill.textContent = "Difference View";
      elVulnScore.textContent = "SSP5-8.5 minus SSP1-2.6";
    } else {
      const activeMetrics = (reg.metrics[state.scenario] && reg.metrics[state.scenario][state.year])
        ? reg.metrics[state.scenario][state.year]
        : (reg.metrics[state.scenario] ? reg.metrics[state.scenario]["2100"] : reg.metrics.ssp126["2100"]);

      targetRiseCm = activeMetrics.rise_cm;
      targetRiseIn = activeMetrics.rise_in;
      elVulnPill.textContent = state.scenario === "ssp126" ? "SSP1-2.6 (Low)" : "SSP5-8.5 (High)";
      elVulnScore.textContent = `Year: ${state.year} Projection`;
    }

    const formatSigned = (val) => {
      const num = typeof val === "number" ? val : parseFloat(val);
      if (isNaN(num)) return "0.0";
      return (num > 0 ? "+" : "") + num.toFixed(1);
    };

    if (animated) {
      const currentCm = parseFloat(elRiseCm.textContent) || 0;
      const currentDiff = parseFloat(elDiffCm.textContent) || 0;

      d3.transition("metric-numbers")
        .duration(1200)
        .tween("metrics", () => {
          const iCm = d3.interpolateNumber(currentCm, targetRiseCm);
          const iDiff = d3.interpolateNumber(currentDiff, diffValCm);
          return function (t) {
            const v = iCm(t);
            const d = iDiff(t);
            elRiseCm.textContent = formatSigned(v);
            elRiseIn.textContent = `(${formatSigned(v / 2.54)} in)`;
            elDiffCm.textContent = formatSigned(d);
            elDiffIn.textContent = `(${formatSigned(d / 2.54)} in)`;
          };
        });
    } else {
      elRiseCm.textContent = formatSigned(targetRiseCm);
      elRiseIn.textContent = `(${formatSigned(targetRiseIn)} in)`;
      elDiffCm.textContent = formatSigned(diffValCm);
      elDiffIn.textContent = `(${formatSigned(diffValIn)} in)`;
    }
  }

  // ========================================================
  // 7. SCROLLAMA SCROLLYTELLING ENGINE
  // ========================================================
  function initScrollama() {
    const scroller = scrollama();

    scroller
      .setup({
        step: ".story-step",
        offset: 0.55,
        debug: false
      })
      .onStepEnter(response => {
        const stepId = response.element.getAttribute("data-step");

        // Highlight active story card
        document.querySelectorAll(".story-step").forEach(el => el.classList.remove("active"));
        response.element.classList.add("active");

        if (stepId && stepId !== state.region) {
          transitionToRegion(stepId);
        }
      });
  }

  // ========================================================
  // 9. UI CONTROLS & EVENT LISTENERS
  // ========================================================
  function initUIControls() {
    // Scenario Buttons
    const scenarioBtns = document.querySelectorAll(".scenario-toggle .toggle-btn");
    scenarioBtns.forEach(btn => {
      btn.addEventListener("click", () => {
        scenarioBtns.forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        state.scenario = btn.getAttribute("data-scenario");
        state.showDifference = false;
        document.getElementById("btn-difference").classList.remove("active");
        updateDataViews(true);
      });
    });

    // Year Buttons
    const yearBtns = document.querySelectorAll(".year-toggle .toggle-btn");
    yearBtns.forEach(btn => {
      btn.addEventListener("click", () => {
        yearBtns.forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        state.year = parseInt(btn.getAttribute("data-year"), 10);
        updateDataViews(true);
      });
    });

    // Difference Button
    const btnDiff = document.getElementById("btn-difference");
    btnDiff.addEventListener("click", () => {
      state.showDifference = !state.showDifference;
      btnDiff.classList.toggle("active", state.showDifference);
      updateDataViews(true);
    });

    // Animate Transition Button (Morph back and forth between SSP1-2.6 and SSP5-8.5)
    const btnAnimate = document.getElementById("btn-animate");
    let animInterval = null;

    function stopAnimation() {
      if (animInterval) {
        clearInterval(animInterval);
        animInterval = null;
      }
      state.isAnimating = false;
      btnAnimate.innerHTML = `<span class="icon">▶</span> Animate Transition`;
      btnAnimate.classList.remove("active");
    }

    function toggleScenarioStep() {
      state.scenario = (state.scenario === "ssp126") ? "ssp585" : "ssp126";
      state.showDifference = false;
      btnDiff.classList.remove("active");

      // Sync scenario buttons UI
      scenarioBtns.forEach(b => {
        b.classList.toggle("active", b.getAttribute("data-scenario") === state.scenario);
      });

      updateDataViews(true);
    }

    btnAnimate.addEventListener("click", () => {
      if (state.isAnimating) {
        stopAnimation();
      } else {
        state.isAnimating = true;
        btnAnimate.innerHTML = `<span class="icon">⏸</span> Pause Animation`;
        btnAnimate.classList.add("active");

        // Trigger immediate step
        toggleScenarioStep();

        // Loop morphing every 2.6s (1.4s transition + 1.2s observation pause)
        animInterval = setInterval(() => {
          toggleScenarioStep();
        }, 2600);
      }
    });

    // Stop animation when user manually clicks other controls
    scenarioBtns.forEach(btn => btn.addEventListener("click", stopAnimation));
    btnDiff.addEventListener("click", stopAnimation);
  }

  // ========================================================
  // 10. RESIZE HANDLER
  // ========================================================
  function handleResize() {
    width = container.clientWidth || window.innerWidth;
    height = container.clientHeight || window.innerHeight;

    svg.attr("width", width)
      .attr("height", height)
      .attr("viewBox", [0, 0, width, height]);

    gSphere.select(".sphere-bg")
      .attr("width", width)
      .attr("height", height);

    const baseScale = calcBaseScale();
    projection
      .scale(baseScale)
      .center([0, 0])
      .translate([width / 2, height / 2]);

    gGraticule.selectAll("path").attr("d", pathGenerator);
    gLand.selectAll(".country-land").attr("d", pathGenerator);
    gOcean.selectAll(".ocean-cell").attr("d", pathGenerator);

    transitionToRegion(state.region, true);
  }

  function debounce(fn, ms) {
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  // Bootstrap when DOM is loaded
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
