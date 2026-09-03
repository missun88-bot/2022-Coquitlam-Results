/*
  How Coquitlam Voted — first complete desktop build

  Tableau translation:
  - CSV files = data sources
  - selectedPlace = parameter/filter state
  - percentOfBallots() = calculated field
  - SVG circles = marks
  - renderResults() = dashboard update action
*/

const formatCount = d3.format(",d");
const formatPercent = d3.format(".1f");

const MAYOR_NAMES = new Map([
  ["STEWART", "Richard Stewart"],
  ["GAMAR", "Adel Gamar"],
  ["MAHOVLICH", "Mark Mahovlich"]
]);

const MAYOR_COLORS = new Map([
  ["STEWART", "#2f7f83"],
  ["GAMAR", "#2f7f83"],
  ["MAHOVLICH", "#2f7f83"]
]);

const state = {
  selectedPlace: "Total",
  locationType: "all",
  showHistory: false,
  firstRender: true
};

const tooltip = d3.select("#tooltip");
const pageError = d3.select("#page-error");

const dataFiles = {
  results: "data/election-results.csv",
  summary: "data/voting-place-summary.csv",
  locations2026: "data/voting-locations-2026.csv",
  boundary: "data/coquitlam-boundary.geojson",
  roads: "data/coquitlam-roads.geojson"
};

Promise.all([
  d3.csv(dataFiles.results, row => ({
    office: row.office,
    candidate: row.candidate,
    elected: row.elected === "Yes",
    votingPlace: row.voting_place,
    category: row.category,
    votes: +row.votes
  })),
  d3.csv(dataFiles.summary, row => ({
    order: +row.order,
    votingPlace: row.voting_place,
    category: row.category,
    ballotsCast: +row.ballots_cast,
    eligibleVoters: row.eligible_voters ? +row.eligible_voters : null,
    turnout: row.turnout ? +row.turnout : null,
    mayorTotalVotes: +row.mayor_total_votes,
    councillorTotalVotes: +row.councillor_total_votes,
    longitude: row.longitude ? +row.longitude : null,
    latitude: row.latitude ? +row.latitude : null
  })),
  d3.csv(dataFiles.locations2026, row => ({
    location: row.location,
    address: row.address,
    longitude: +row.longitude,
    latitude: +row.latitude,
    category: row.category
  })),
  d3.json(dataFiles.boundary),
  d3.json(dataFiles.roads)
]).then(([results, summaries, locations2026, boundary, roads]) => {
  initialize({ results, summaries, locations2026, boundary, roads });
}).catch(error => {
  console.error(error);
  pageError
    .attr("hidden", null)
    .text("The data could not be loaded. Open this project through the local Python server rather than double-clicking index.html.");
});

function initialize(data) {
  data.summaryByPlace = new Map(data.summaries.map(d => [d.votingPlace, d]));
  data.resultsByOfficePlace = d3.group(data.results, d => d.office, d => d.votingPlace);
  data.councilOrder = createCouncilOrder(data.resultsByOfficePlace);
  data.locations2026Unique = combine2026Locations(data.locations2026);

  validateData(data);
  buildPlaceSelector(data);
  drawHeroIllustration(data);
  renderResults(data, false);
  drawMap(data);
  setupScrollResults();
  setupStickyHeading();

  d3.select("#place-select").on("change", event => {
    state.selectedPlace = event.target.value;
    renderResults(data, true);
  });

  d3.select("#location-type").on("change", event => {
    state.locationType = event.target.value;
    updateMapFilters();
  });

  d3.select("#history-layer").on("change", event => {
    state.showHistory = event.target.checked;
    updateMapFilters();
  });
}

function validateData(data) {
  const total = data.summaryByPlace.get("Total");
  const mayorTotal = d3.sum(data.resultsByOfficePlace.get("Mayor").get("Total"), d => d.votes);
  const councilTotal = d3.sum(data.resultsByOfficePlace.get("Councillor").get("Total"), d => d.votes);

  const problems = [];
  if (!total || total.ballotsCast !== 20668) problems.push("citywide ballot total");
  if (mayorTotal !== total.mayorTotalVotes) problems.push("mayoral reconciliation");
  if (councilTotal !== total.councillorTotalVotes) problems.push("council reconciliation");
  if (data.councilOrder.length !== 22) problems.push("council candidate count");

  if (problems.length) {
    throw new Error(`Data validation failed: ${problems.join(", ")}`);
  }
}

function createCouncilOrder(groupedResults) {
  return [...groupedResults.get("Councillor").get("Total")]
    .sort((a, b) => d3.descending(a.votes, b.votes))
    .map(d => ({ candidate: d.candidate, elected: d.elected }));
}

function combine2026Locations(rows) {
  const combined = d3.rollup(
    rows,
    group => ({
      location: group[0].location,
      address: group[0].address,
      longitude: group[0].longitude,
      latitude: group[0].latitude,
      categories: new Set(group.map(d => d.category))
    }),
    d => `${d.location}|${d.address}`
  );

  return [...combined.values()].map(d => {
    const hasGeneral = d.categories.has("Voting place");
    const hasAdvance = d.categories.has("Advance");
    return {
      ...d,
      type: hasGeneral && hasAdvance ? "both" : hasAdvance ? "advance" : "general"
    };
  });
}

function buildPlaceSelector(data) {
  const select = d3.select("#place-select");
  const ordered = [...data.summaries].sort((a, b) => d3.ascending(a.order, b.order));

  select.append("option").attr("value", "Total").text("Citywide total");

  const groups = [
    { label: "Election Day", category: "Voting place" },
    { label: "Advance voting", category: "Advance" },
    { label: "Other", category: "Mobile" }
  ];

  groups.forEach(group => {
    const records = ordered.filter(d => d.category === group.category);
    if (!records.length) return;
    const optionGroup = select.append("optgroup").attr("label", group.label);
    optionGroup.selectAll("option")
      .data(records)
      .join("option")
      .attr("value", d => d.votingPlace)
      .text(d => d.votingPlace);
  });
}

function renderResults(data, animate) {
  const summary = data.summaryByPlace.get(state.selectedPlace);
  const mayorRows = data.resultsByOfficePlace.get("Mayor").get(state.selectedPlace);
  const councilRows = data.resultsByOfficePlace.get("Councillor").get(state.selectedPlace);

  const councilByCandidate = new Map(councilRows.map(d => [d.candidate, d]));
  const councilOrdered = data.councilOrder.map(orderRow => ({
    ...councilByCandidate.get(orderRow.candidate),
    elected: orderRow.elected
  }));

  const selectedLabel = state.selectedPlace === "Total" ? "Citywide total" : state.selectedPlace;
  d3.select("#selected-place").text(selectedLabel);
  d3.select("#selected-ballots").text(formatCount(summary.ballotsCast));
  d3.select("#selected-mayor-votes").text(formatCount(summary.mayorTotalVotes));

  const mayorData = mayorRows
    .map(d => ({
      ...d,
      displayName: MAYOR_NAMES.get(d.candidate) || titleCase(d.candidate),
      percent: percentOfBallots(d.votes, summary.ballotsCast),
      color: MAYOR_COLORS.get(d.candidate) || "#2f7f83",
      ballotsCast: summary.ballotsCast,
      placeLabel: selectedLabel
    }))
    .sort((a, b) => d3.descending(a.votes, b.votes));

  const councilData = councilOrdered.map(d => ({
    ...d,
    displayName: titleCase(d.candidate),
    percent: percentOfBallots(d.votes, summary.ballotsCast),
    color: d.elected ? "#2f7f83" : "#6ba6a1",
    ballotsCast: summary.ballotsCast,
    placeLabel: selectedLabel
  }));

  renderRingChart({
    selector: "#mayor-chart",
    data: mayorData,
    width: 780,
    height: 440,
    centerX: 400,
    centerY: 220,
    outerRadius: 180,
    innerRadius: 76,
    strokeWidth: 20,
    startAngle: -90,
    twoLineLabels: true,
    animate
  });

  renderRingChart({
    selector: "#council-elected-chart",
    data: councilData.filter(d => d.elected).sort((a, b) => d3.descending(a.votes, b.votes)),
    width: 620,
    height: 570,
    centerX: 310,
    centerY: 285,
    outerRadius: 242,
    innerRadius: 82,
    strokeWidth: 12,
    startAngle: -90,
    twoLineLabels: false,
    centreLabel: ["8 Elected", "councillors"],
    animate
  });

  renderRingChart({
    selector: "#council-other-chart",
    data: councilData.filter(d => !d.elected).sort((a, b) => d3.descending(a.votes, b.votes)),
    width: 620,
    height: 570,
    centerX: 310,
    centerY: 285,
    outerRadius: 242,
    innerRadius: 64,
    strokeWidth: 10,
    startAngle: -90,
    twoLineLabels: false,
    centreLabel: ["14 Other", "candidates"],
    animate
  });

  state.firstRender = false;
}

function percentOfBallots(votes, ballotsCast) {
  return ballotsCast ? (votes / ballotsCast) * 100 : 0;
}

function drawHeroIllustration(data) {
  const background = d3.select("#hero-background-map")
    .attr("viewBox", "0 0 1440 680")
    .attr("preserveAspectRatio", "xMidYMid slice");
  if (background.empty()) return;

  const projection = d3.geoMercator().fitExtent([[790, 28], [1415, 652]], data.boundary);
  const path = d3.geoPath(projection);

  background.selectAll("path.hero-background-boundary")
    .data([data.boundary])
    .join("path")
    .attr("class", "hero-background-boundary")
    .attr("d", path);

  background.selectAll("path.hero-background-roads")
    .data([data.roads])
    .join("path")
    .attr("class", "hero-background-roads")
    .attr("d", path);
}

function renderRingChart(config) {
  const {
    selector,
    data,
    width,
    height,
    centerX,
    centerY,
    outerRadius,
    innerRadius,
    strokeWidth,
    startAngle,
    twoLineLabels,
    centreLabel,
    animate
  } = config;

  const svg = d3.select(selector).attr("viewBox", `0 0 ${width} ${height}`);
  const scrollSection = svg.node().closest("[data-scroll-result]");
  const sectionActive = !scrollSection || scrollSection.classList.contains("is-active");
  const rootGroup = svg.selectAll("g.ring-root").data([null]).join("g").attr("class", "ring-root");
  const ringStep = data.length === 1 ? 0 : (outerRadius - innerRadius) / (data.length - 1);
  const startRadians = startAngle * Math.PI / 180;
  const transition = d3.transition().duration(720).ease(d3.easeCubicInOut);

  const positioned = data.map((d, index) => ({
    ...d,
    radius: outerRadius - index * ringStep
  }));

  const tracks = rootGroup.selectAll("circle.ring-track")
    .data(positioned, d => d.candidate)
    .join("circle")
    .attr("class", "ring-track")
    .attr("cx", centerX)
    .attr("cy", centerY)
    .attr("r", d => d.radius)
    .attr("stroke-width", strokeWidth);

  const values = rootGroup.selectAll("circle.ring-value")
    .data(positioned, d => d.candidate)
    .join(
      enter => enter.append("circle")
        .attr("class", "ring-value")
        .attr("cx", centerX)
        .attr("cy", centerY)
        .attr("fill", "none")
        .attr("pathLength", 100)
        .attr("tabindex", 0)
        .each(function(d) { this._previousPercent = d.percent; }),
      update => update,
      exit => exit.remove()
    )
    .attr("r", d => d.radius)
    .attr("stroke", d => d.color)
    .attr("stroke-width", strokeWidth)
    .attr("transform", `rotate(${startAngle} ${centerX} ${centerY})`)
    .attr("aria-label", d => `${d.displayName}: ${formatCount(d.votes)} votes, ${formatPercent(d.percent)} percent of ${formatCount(d.ballotsCast)} ballots cast at ${d.placeLabel}`);

  if (!sectionActive) {
    values
      .attr("stroke-dasharray", "0 100")
      .each(function() { this._previousPercent = 0; });
  } else if (animate && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    values.each(function(d) {
      const previous = Number.isFinite(this._previousPercent) ? this._previousPercent : d.percent;
      d3.select(this)
        .attr("stroke-dasharray", `${previous} 100`)
        .transition(transition)
        .attr("stroke-dasharray", `${d.percent} 100`)
        .on("end", () => { this._previousPercent = d.percent; });
    });
  } else {
    values
      .attr("stroke-dasharray", d => `${d.percent} 100`)
      .each(function(d) { this._previousPercent = d.percent; });
  }

  addRingTooltip(values);

  if (twoLineLabels) {
    const labelGroups = rootGroup.selectAll("g.ring-label")
      .data(positioned, d => d.candidate)
      .join("g")
      .attr("class", "ring-label")
      .attr("transform", d => {
        const x = centerX + d.radius * Math.cos(startRadians) - 18;
        const y = centerY + d.radius * Math.sin(startRadians);
        return `translate(${x},${y})`;
      });

    labelGroups.selectAll("text.ring-label-name")
      .data(d => [d])
      .join("text")
      .attr("class", "ring-label-name")
      .attr("text-anchor", "end")
      .attr("y", -4)
      .text(d => d.displayName);

    labelGroups.selectAll("text.ring-label-value")
      .data(d => [d])
      .join("text")
      .attr("class", "ring-label-value")
      .attr("text-anchor", "end")
      .attr("y", 15)
      .text(d => `${formatCount(d.votes)} · ${formatPercent(d.percent)}%`);
  } else {
    rootGroup.selectAll("text.ring-label")
      .data(positioned, d => d.candidate)
      .join("text")
      .attr("class", "ring-label ring-label-name")
      .attr("text-anchor", "end")
      .attr("x", d => centerX + d.radius * Math.cos(startRadians) - 14)
      .attr("y", d => centerY + d.radius * Math.sin(startRadians) + 4)
      .each(function(d) {
        const text = d3.select(this);
        text.selectAll("tspan").remove();
        text.append("tspan").text(`${d.displayName} `);
        text.append("tspan")
          .attr("class", "ring-label-value")
          .text(`${formatCount(d.votes)} · ${formatPercent(d.percent)}%`);
      });
  }

  const centreText = rootGroup.selectAll("text.ring-centre-label")
    .data(centreLabel ? [centreLabel] : [])
    .join("text")
    .attr("class", "ring-centre-label")
    .attr("x", centerX)
    .attr("y", centerY - (((centreLabel ? centreLabel.length : 1) - 1) * 9));

  centreText.selectAll("tspan")
    .data(d => d)
    .join("tspan")
    .attr("x", centerX)
    .attr("dy", (d, index) => index === 0 ? 0 : 19)
    .text(d => d);

  tracks.lower();
}

function setupScrollResults() {
  const sections = document.querySelectorAll("[data-scroll-result]");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const mobileFlow = window.matchMedia("(max-width: 720px)").matches;

  if (reduceMotion || mobileFlow || !("IntersectionObserver" in window)) {
    sections.forEach(section => activateScrollResult(section, false));
    return;
  }

  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      activateScrollResult(entry.target, true);
      observer.unobserve(entry.target);
    });
  }, {
    threshold: 0.2,
    rootMargin: "-12% 0px -18% 0px"
  });

  sections.forEach(section => observer.observe(section));
}

function setupStickyHeading() {
  const heading = document.querySelector("#results-sticky-heading");
  const council = document.querySelector(".council");
  const stickyBar = document.querySelector(".results-sticky");
  if (!heading || !council || !stickyBar) return;

  const defaultHeading = "A decisive mayoral win in a low-turnout election";
  const councilHeading = "Six incumbents returned. Two newcomers joined them.";
  let ticking = false;

  const updateHeading = () => {
    const mobileFlow = window.matchMedia("(max-width: 720px)").matches;
    const councilBounds = council.getBoundingClientRect();
    const triggerLine = stickyBar.getBoundingClientRect().height + 8;
    const councilIsCurrent = !mobileFlow &&
      councilBounds.top <= triggerLine &&
      councilBounds.bottom > triggerLine;

    heading.textContent = councilIsCurrent ? councilHeading : defaultHeading;
    ticking = false;
  };

  const requestUpdate = () => {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(updateHeading);
  };

  window.addEventListener("scroll", requestUpdate, { passive: true });
  window.addEventListener("resize", requestUpdate);
  updateHeading();
}

function activateScrollResult(section, animate) {
  section.classList.add("is-active");
  const rings = d3.select(section).selectAll("circle.ring-value");

  if (!animate) {
    rings
      .attr("stroke-dasharray", d => `${d.percent} 100`)
      .each(function(d) { this._previousPercent = d.percent; });
    return;
  }

  rings.each(function(d) {
    d3.select(this)
      .attr("stroke-dasharray", "0 100")
      .transition()
      .duration(820)
      .ease(d3.easeCubicOut)
      .attr("stroke-dasharray", `${d.percent} 100`)
      .on("end", () => { this._previousPercent = d.percent; });
  });
}

function addRingTooltip(selection) {
  selection
    .on("pointerenter pointermove", (event, d) => {
      showTooltip(event, ringTooltipHtml(d));
    })
    .on("pointerleave", hideTooltip)
    .on("focus", function(event, d) {
      const rect = this.getBoundingClientRect();
      showTooltipAt(rect.right, rect.top + rect.height / 2, ringTooltipHtml(d));
    })
    .on("blur", hideTooltip);
}

function ringTooltipHtml(d) {
  const status = d.office === "Councillor"
    ? `<div class="tooltip-note">${d.elected ? "Elected citywide" : "Not elected citywide"}</div>`
    : "";

  return `
    <strong>${escapeHtml(d.displayName)}</strong>
    <div class="tooltip-row"><span>Votes</span><span>${formatCount(d.votes)}</span></div>
    <div class="tooltip-row"><span>Ballot percentage</span><span>${formatPercent(d.percent)}%</span></div>
    <div class="tooltip-row"><span>Ballots cast</span><span>${formatCount(d.ballotsCast)}</span></div>
    <div class="tooltip-note">${escapeHtml(d.placeLabel)}</div>
    ${status}
  `;
}

function drawMap(data) {
  const svg = d3.select("#location-map").attr("viewBox", "0 0 1000 650");
  const locationFeatures = {
    type: "FeatureCollection",
    features: data.locations2026Unique.map(d => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [d.longitude, d.latitude] },
      properties: d
    }))
  };

  const projection = d3.geoMercator().fitExtent([[55, 42], [945, 610]], locationFeatures);
  const path = d3.geoPath(projection);

  const defs = svg.append("defs");
  defs.append("clipPath")
    .attr("id", "map-clip")
    .append("rect")
    .attr("width", 1000)
    .attr("height", 650);

  const mapRoot = svg.append("g").attr("clip-path", "url(#map-clip)");

  mapRoot.append("path")
    .datum(data.boundary)
    .attr("class", "map-boundary")
    .attr("d", path);

  mapRoot.append("path")
    .datum(data.roads)
    .attr("class", "map-roads")
    .attr("d", path);

  const historyRows = data.summaries.filter(d =>
    d.votingPlace !== "Total" &&
    Number.isFinite(d.longitude) &&
    Number.isFinite(d.latitude) &&
    d.ballotsCast > 0
  );

  // The same building could host more than one 2022 voting session. Combine
  // exact locations so the history layer represents total use of the building.
  const historyData = d3.rollups(
    historyRows,
    rows => ({
      longitude: rows[0].longitude,
      latitude: rows[0].latitude,
      ballotsCast: d3.sum(rows, d => d.ballotsCast),
      votingPlaces: rows.map(d => d.votingPlace),
      categories: Array.from(new Set(rows.map(d => d.category)))
    }),
    d => `${d.longitude.toFixed(5)}|${d.latitude.toFixed(5)}`
  ).map(([, value]) => value);

  const historyRadius = d3.scaleSqrt()
    .domain(d3.extent(historyData, d => d.ballotsCast))
    .range([6, 27]);

  drawHistorySizeLegend(historyRadius);

  svg.append("g")
    .attr("class", "history-layer")
    .selectAll("circle")
    .data(historyData)
    .join("circle")
    .attr("class", "history-mark")
    .attr("cx", d => projection([d.longitude, d.latitude])[0])
    .attr("cy", d => projection([d.longitude, d.latitude])[1])
    .attr("r", d => historyRadius(d.ballotsCast))
    .attr("tabindex", 0)
    .attr("aria-label", d => `${d.votingPlaces.join(" and ")}: ${formatCount(d.ballotsCast)} ballots cast in 2022`)
    .on("pointerenter pointermove", (event, d) => showTooltip(event, historyTooltipHtml(d)))
    .on("pointerleave", hideTooltip)
    .on("focus", function(event, d) {
      const rect = this.getBoundingClientRect();
      showTooltipAt(rect.right, rect.top + rect.height / 2, historyTooltipHtml(d));
    })
    .on("blur", hideTooltip);

  const locationLayer = svg.append("g").attr("class", "location-layer");
  const locationGroups = locationLayer.selectAll("g.location-group")
    .data(data.locations2026Unique, d => d.location)
    .join("g")
    .attr("class", d => `location-group location-group--${d.type}`)
    .attr("transform", d => {
      const [x, y] = projection([d.longitude, d.latitude]);
      return `translate(${x},${y})`;
    });

  locationGroups.each(function(d) {
    const group = d3.select(this);
    if (d.type === "both") {
      group.append("circle").attr("class", "location-mark location-mark--both-outer").attr("r", 11);
      group.append("circle").attr("class", "location-mark--both-inner").attr("r", 5);
    } else {
      group.append("circle").attr("class", `location-mark location-mark--${d.type}`).attr("r", d.type === "advance" ? 9 : 7);
    }
  });

  locationGroups
    .attr("tabindex", 0)
    .attr("aria-label", d => `${d.location}, ${d.address}, ${mapTypeLabel(d.type)}`)
    .on("pointerenter pointermove", (event, d) => showTooltip(event, locationTooltipHtml(d)))
    .on("pointerleave", hideTooltip)
    .on("focus", function(event, d) {
      const rect = this.getBoundingClientRect();
      showTooltipAt(rect.right, rect.top + rect.height / 2, locationTooltipHtml(d));
    })
    .on("blur", hideTooltip);

  addVictoriaAnnotation(svg, data.locations2026Unique, projection);

  svg.append("text")
    .attr("class", "map-caption")
    .attr("x", 18)
    .attr("y", 630)
    .text("Urban Coquitlam · hover or focus a marker for details");

  updateMapFilters();
}

function drawHistorySizeLegend(radiusScale) {
  const values = [250, 1000, 3500];
  const xPositions = [34, 112, 214];
  const baseline = 53;
  const svg = d3.select("#history-size-legend").attr("viewBox", "0 0 252 78");

  const groups = svg.selectAll("g.history-size-item")
    .data(values)
    .join("g")
    .attr("class", "history-size-item")
    .attr("transform", (d, index) => `translate(${xPositions[index]},0)`);

  groups.selectAll("circle")
    .data(d => [d])
    .join("circle")
    .attr("class", "history-size-circle")
    .attr("cy", d => baseline - radiusScale(d))
    .attr("r", d => radiusScale(d));

  groups.selectAll("text")
    .data(d => [d])
    .join("text")
    .attr("class", "history-size-label")
    .attr("y", 73)
    .text(d => d3.format(",d")(d));
}

function addVictoriaAnnotation(svg, locations, projection) {
  const victoria = locations.find(d => d.location === "Victoria Community Hall");
  if (!victoria) return;

  const [x, y] = projection([victoria.longitude, victoria.latitude]);
  const boxWidth = 310;
  const boxHeight = 64;
  const boxX = 660;
  const boxY = 430;
  const annotation = svg.append("g").attr("class", "victoria-annotation").attr("pointer-events", "none");

  annotation.append("path")
    .attr("class", "map-annotation-line")
    .attr("d", `M${x},${y + 11} L${x},${boxY - 24} L${boxX + boxWidth - 34},${boxY}`);

  annotation.append("rect")
    .attr("class", "map-annotation-box")
    .attr("x", boxX)
    .attr("y", boxY)
    .attr("width", boxWidth)
    .attr("height", boxHeight)
    .attr("rx", 7);

  annotation.append("text")
    .attr("class", "map-annotation-title")
    .attr("x", boxX + 18)
    .attr("y", boxY + 26)
    .text("Victoria Community Hall");

  annotation.append("text")
    .attr("class", "map-annotation-sub")
    .attr("x", boxX + 18)
    .attr("y", boxY + 47)
    .text("Advance voting + General Voting Day");
}

function updateMapFilters() {
  d3.selectAll(".location-group")
    .attr("display", d => {
      if (state.locationType === "all") return null;
      if (d.type === "both") return null;
      return d.type === state.locationType ? null : "none";
    });

  d3.select(".history-layer")
    .attr("display", state.showHistory ? null : "none");

  d3.select(".history-legend")
    .attr("hidden", state.showHistory ? null : true);

  const victoriaVisible = state.locationType === "all" || state.locationType === "general" || state.locationType === "advance";
  d3.select(".victoria-annotation").attr("display", victoriaVisible ? null : "none");
}

function historyTooltipHtml(d) {
  const combinedNote = d.votingPlaces.length > 1
    ? `<div class="tooltip-note">Combined sessions at this physical location: ${escapeHtml(d.votingPlaces.join(", "))}.</div>`
    : "";

  return `
    <strong>${escapeHtml(d.votingPlaces.join(" + "))}</strong>
    <div class="tooltip-row"><span>2022 ballots cast</span><span>${formatCount(d.ballotsCast)}</span></div>
    <div class="tooltip-row"><span>Voting type</span><span>${escapeHtml(d.categories.join(" + "))}</span></div>
    ${combinedNote}
    <div class="tooltip-note">Historical context only—not a forecast of 2026 traffic.</div>
  `;
}

function locationTooltipHtml(d) {
  const schedule = advanceSchedule(d.location);
  const advanceLine = d.type === "advance" || d.type === "both"
    ? `<div class="tooltip-note"><strong>Advance voting</strong>${escapeHtml(schedule)}</div>`
    : "";
  const generalLine = d.type === "general" || d.type === "both"
    ? `<div class="tooltip-note"><strong>General Voting Day</strong>Saturday, October 17 · 8 a.m.–8 p.m.</div>`
    : "";

  return `
    <strong>${escapeHtml(d.location)}</strong>
    <div>${escapeHtml(d.address)}</div>
    <div class="tooltip-row"><span>Voting type</span><span>${mapTypeLabel(d.type)}</span></div>
    ${advanceLine}
    ${generalLine}
  `;
}

function advanceSchedule(location) {
  const schedules = {
    "Town Centre Park Community Centre": "October 5, 8 and 10 · 8 a.m.–8 p.m.",
    "Centennial Pavilion": "October 7, 10, 13 and 15 · 8 a.m.–8 p.m.",
    "Victoria Community Hall": "October 10 · 8 a.m.–8 p.m."
  };
  return schedules[location] || "See the City website for dates.";
}

function mapTypeLabel(type) {
  if (type === "both") return "Advance + General Voting Day";
  if (type === "advance") return "Advance voting";
  return "General Voting Day";
}

function showTooltip(event, html) {
  showTooltipAt(event.clientX, event.clientY, html);
}

function showTooltipAt(clientX, clientY, html) {
  tooltip.html(html).attr("hidden", null);
  const node = tooltip.node();
  const margin = 14;
  const width = node.offsetWidth;
  const height = node.offsetHeight;
  const left = clientX + 16 + width > window.innerWidth - margin
    ? clientX - width - 16
    : clientX + 16;
  const top = clientY + 16 + height > window.innerHeight - margin
    ? clientY - height - 16
    : clientY + 16;

  tooltip
    .style("left", `${Math.max(margin, left)}px`)
    .style("top", `${Math.max(margin, top)}px`);
}

function hideTooltip() {
  tooltip.attr("hidden", true);
}

function titleCase(value) {
  if (value === "McBRYER") return "McBryer";
  return value.toLowerCase().replace(/(^|[\s-])\S/g, character => character.toUpperCase());
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
