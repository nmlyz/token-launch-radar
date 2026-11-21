// Token Launch Radar — dashboard logic. Renders window.RADAR_DATA (written
// by main.ts from the sealed snapshot). No network: every byte is local.
(function () {
  "use strict";
  var D = window.RADAR_DATA;
  var rows = D.rows;
  var PAGE = 50;
  var page = 0;
  var selected = null;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function money(n) {
    if (n >= 1e9) return "$" + trim(n / 1e9) + "B";
    if (n >= 1e6) return "$" + trim(n / 1e6) + "M";
    if (n >= 1e3) return "$" + trim(n / 1e3) + "K";
    return "$" + Math.round(n).toLocaleString("en-US");
  }
  function trim(n) { return n.toFixed(2).replace(/\.?0+$/, ""); }
  function pct(c) {
    if (c === null || c === undefined) return '<span class="flat">—</span>';
    var cls = c > 0 ? "up" : c < 0 ? "down" : "flat";
    var sign = c > 0 ? "+" : "";
    return '<span class="' + cls + '">' + sign + c.toFixed(1) + "%</span>";
  }
  function age(a) {
    if (a === null || a === undefined) return "—";
    if (a < 30) return a + "d";
    if (a < 365) return Math.round(a / 30.4) + "mo";
    return (a / 365).toFixed(1) + "y";
  }
  function chains(c) {
    if (!c || !c.length) return "—";
    return esc(c.slice(0, 3).join(", ")) + (c.length > 3 ? " +" + (c.length - 3) : "");
  }

  // ---- header stats -------------------------------------------------------
  var wl = rows.filter(function (r) { return r.watchlist; }).length;
  var med = rows.slice().sort(function (a, b) { return a.implied_value_usd - b.implied_value_usd; });
  $("stats").innerHTML =
    stat(rows.length, "pre-token ranked") +
    stat(wl, "on the watchlist") +
    stat(money(med[Math.floor(med.length / 2)].implied_value_usd), "median implied") +
    stat(D.meta.global_multiple.toFixed(2) + "x", "global multiple");
  function stat(v, l) {
    return '<div class="stat"><b>' + v + "</b><span>" + l + "</span></div>";
  }
  $("asof").textContent =
    "Snapshot as of " + D.as_of + " · " + D.meta.protocols_total +
    " protocols in the file · floor " + money(D.meta.floor_usd) + " · " +
    D.meta.pre_token_total + " record no token · " + D.meta.excluded_total +
    " of them left out by the watchlist rule (bridges, exchanges, wrapped/staked products, versioned copies).";

  // ---- filter controls ----------------------------------------------------
  var cats = {}, chs = {};
  rows.forEach(function (r) {
    if (r.category) cats[r.category] = 1;
    (r.chains || []).forEach(function (c) { chs[c] = 1; });
  });
  fillSelect($("cat"), Object.keys(cats).sort());
  fillSelect($("chain"), Object.keys(chs).sort());
  function fillSelect(sel, items) {
    items.forEach(function (it) {
      var o = document.createElement("option");
      o.value = it; o.textContent = it; sel.appendChild(o);
    });
  }

  var params = new URLSearchParams(location.search);
  if (params.get("category")) $("cat").value = params.get("category");
  if (params.get("chain")) $("chain").value = params.get("chain");
  if (params.get("watchlist") === "1") $("wl").checked = true;
  if (params.get("q")) $("q").value = params.get("q");

  ["q", "cat", "chain", "wl", "sort"].forEach(function (id) {
    $(id).addEventListener("input", function () { page = 0; render(); });
    $(id).addEventListener("change", function () { page = 0; render(); });
  });
  $("prev").addEventListener("click", function () { if (page > 0) { page--; render(); } });
  $("next").addEventListener("click", function () { page++; render(); });
  $("d-close").addEventListener("click", function () { select(null); });

  function filtered() {
    var q = $("q").value.trim().toLowerCase();
    var cat = $("cat").value, chain = $("chain").value, onlyWl = $("wl").checked;
    var list = rows.filter(function (r) {
      if (onlyWl && !r.watchlist) return false;
      if (cat && r.category !== cat) return false;
      if (chain && (r.chains || []).indexOf(chain) < 0) return false;
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.indexOf(q) < 0) return false;
      return true;
    });
    var s = $("sort").value;
    var key = { implied: "implied_value_usd", tvl: "tvl_usd", growth: "change_7d", age: "age_days" }[s];
    list.sort(function (a, b) {
      var av = a[key], bv = b[key];
      if (av === null || av === undefined) av = -Infinity;
      if (bv === null || bv === undefined) bv = -Infinity;
      return bv - av || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1);
    });
    return list;
  }

  function rowHtml(r) {
    return "<tr data-slug=\"" + esc(r.slug) + "\"" + (selected === r.slug ? ' class="sel"' : "") + ">" +
      '<td class="num">' + r.rank + "</td>" +
      '<td class="name"><b>' + esc(r.name) + '</b><span class="slug">' + esc(r.slug) + "</span>" +
      (r.watchlist ? '<span class="badge wl">WATCHLIST</span>' : "") +
      '<span class="badge pre">PRE-TOKEN</span></td>' +
      "<td>" + esc(r.category || "—") + "</td>" +
      "<td>" + chains(r.chains) + "</td>" +
      '<td class="num">' + money(r.tvl_usd) + "</td>" +
      '<td class="num">' + pct(r.change_7d) + "</td>" +
      '<td class="num">' + age(r.age_days) + "</td>" +
      '<td class="num"><b>' + money(r.implied_value_usd) + "</b></td>" +
      '<td class="num">' + r.model.multiple.toFixed(2) + "x</td></tr>";
  }

  function render() {
    var list = filtered();
    var pages = Math.max(1, Math.ceil(list.length / PAGE));
    if (page >= pages) page = pages - 1;
    var slice = list.slice(page * PAGE, page * PAGE + PAGE);
    $("rows").innerHTML = slice.map(rowHtml).join("") ||
      '<tr><td colspan="9">No protocol matches these filters.</td></tr>';
    $("rows").querySelectorAll("tr[data-slug]").forEach(function (tr) {
      tr.addEventListener("click", function () { select(tr.getAttribute("data-slug")); });
    });
    $("count").textContent = list.length + " of " + rows.length + " shown";
    $("page").textContent = "Page " + (page + 1) + " / " + pages;
    $("prev").disabled = page === 0;
    $("next").disabled = page >= pages - 1;
  }

  // ---- detail view ---------------------------------------------------------
  function select(slug) {
    selected = slug;
    var box = $("detail");
    if (!slug) { box.hidden = true; render(); return; }
    var r = rows.filter(function (x) { return x.slug === slug; })[0];
    if (!r) { box.hidden = true; return; }
    $("d-name").textContent = "#" + r.rank + " " + r.name;
    $("d-badges").innerHTML =
      (r.watchlist ? '<span class="badge wl">WATCHLIST</span>' : "") +
      '<span class="badge pre">PRE-TOKEN · records no token</span>';
    var m = r.model;
    $("d-grid").innerHTML = cell("TVL", money(r.tvl_usd)) +
      cell("7-day change", r.change_7d === null ? "not reported" : (r.change_7d > 0 ? "+" : "") + r.change_7d.toFixed(2) + "%") +
      cell("Age", r.listed_at ? r.listed_at + " (" + age(r.age_days) + ")" : "not reported") +
      cell("Category", r.category || "—") +
      cell("Chains", (r.chains || []).slice(0, 5).join(", ") +
        ((r.chains || []).length > 5 ? " +" + ((r.chains || []).length - 5) + " more" : "") || "—") +
      cell("Implied value", money(r.implied_value_usd));
    function cell(l, v) {
      return '<div class="d-cell"><span>' + l + "</span><b>" + esc(v) + "</b></div>";
    }
    $("d-formula").innerHTML =
      money(r.tvl_usd) + " TVL &times; " + m.multiple.toFixed(3) + "x " +
      esc(r.category || "category") + " multiple &times; " + m.growth_factor.toFixed(3) +
      " growth &times; " + m.maturity_factor.toFixed(3) + " maturity &times; " +
      m.breadth_factor.toFixed(3) + " breadth<br>" +
      "= " + money(m.base_value_usd) + " base &times; " +
      (m.growth_factor * m.maturity_factor * m.breadth_factor).toFixed(3) +
      " combined factors = <span class=\"res\">" + money(r.implied_value_usd) + "</span><br>" +
      "Multiple: median mcap/TVL of token-bearing " + esc(r.category || "category") +
      " protocols in this snapshot (global median " + D.meta.global_multiple.toFixed(3) + "x as fallback).";
    $("d-steps").innerHTML = r.farm_steps.map(function (s) {
      return "<li>" + esc(s) + "</li>";
    }).join("");
    box.hidden = false;
    render();
  }

  // ---- comparables ----------------------------------------------------------
  $("comp-rows").innerHTML = D.meta.comparables.map(function (c) {
    return "<tr><td>" + esc(c.name) + ' <span style="color:var(--faint)">' + esc(c.slug) + "</span></td>" +
      "<td>" + esc(c.category || "—") + "</td>" +
      '<td class="num">' + money(c.tvl_usd) + "</td>" +
      '<td class="num">' + money(c.mcap_usd) + "</td>" +
      '<td class="num">' + c.ratio.toFixed(2) + "x</td></tr>";
  }).join("");

  render();
  var detail = params.get("detail");
  if (detail) {
    document.querySelector("main").classList.add("detail-first");
    select(detail);
  }
})();
