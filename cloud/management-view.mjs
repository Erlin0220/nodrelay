export const consoleStyles = String.raw`
  :root {
    color-scheme: dark;
    --bg: #0a0a0a; --bar: #111; --surface: #121212; --inset: #171717;
    --hover: #1d1d1d; --selected: #191919; --line: #333; --rule: #272727;
    --text: #f1f1f1; --secondary: #adadad; --blue: #2165dc; --blue-hover: #286ce4;
    --active: #38d5a0; --pending: #e6ae57; --disabled: #969696; --focus: #78aaff;
    --risk: #ff9599; --risk-bg: #412426; --filter-border: #333;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  :root[data-theme="light"] {
    color-scheme: light;
    --bg: #fcfcfc; --bar: #fff; --surface: #f7f7f7; --inset: #f1f1f1;
    --hover: #e9e9e9; --selected: #e9e9e9; --line: #d2d2d2; --rule: #dedede;
    --text: #171717; --secondary: #4d4d4d; --active: #008a5e; --pending: #926000;
    --disabled: #747474; --focus: #165dcc; --risk: #a41e27; --risk-bg: #f9dfe0;
    --filter-border: #bbb;
  }
  @media (prefers-color-scheme: light) {
    :root:not([data-theme]) {
    color-scheme: light;
    --bg: #fcfcfc; --bar: #fff; --surface: #f7f7f7; --inset: #f1f1f1;
    --hover: #e9e9e9; --selected: #e9e9e9; --line: #d2d2d2; --rule: #dedede;
    --text: #171717; --secondary: #4d4d4d; --active: #008a5e; --pending: #926000;
    --disabled: #747474; --focus: #165dcc; --risk: #a41e27; --risk-bg: #f9dfe0;
    --filter-border: #bbb;
    }
  }
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); }
  [hidden] { display: none !important; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  :focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  button, input, select { font: inherit; color: inherit; }
  button { cursor: pointer; }
  button, input, select { border: 1px solid var(--line); border-radius: 8px; background: var(--inset); }
  button:hover { background: var(--hover); }
  .icon { width: 16px; height: 16px; flex: none; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; padding: 0 12px; min-height: 34px; white-space: nowrap; }
  .primary { background: var(--blue); border-color: var(--blue); color: #fff; font-weight: 590; min-height: 36px; padding-inline: 12px 14px; }
  .primary:hover { background: var(--blue-hover); border-color: var(--blue-hover); }
  button:disabled, button[aria-disabled="true"] { cursor: default; opacity: .58; }

  .topbar { min-height: 54px; padding: 7px 22px; display: flex; align-items: center; justify-content: space-between; gap: 16px; background: var(--bar); border-bottom: 1px solid var(--rule); }
  .brand { display: inline-flex; align-items: center; gap: 9px; font-size: 16px; font-weight: 650; }
  .brand img { display: block; width: 28px; height: 28px; border-radius: 5px; }
  .brand-version { color: var(--secondary); font-size: 12px; font-weight: 500; white-space: nowrap; }
  .brand .upgrade-launch { display: inline-grid; place-items: center; width: 32px; min-height: 32px; padding: 0; border-color: transparent; background: transparent; color: light-dark(#c62828, #ff686d); }
  .brand .upgrade-launch:hover { background: color-mix(in srgb, currentColor 10%, transparent); }
  .upgrade-launch .icon { width: 21px; height: 21px; }
  .upgrade-launch .upgrade-recovery-icon,
  .upgrade-launch[data-mode="recovery"] .upgrade-available-icon { display: none; }
  .upgrade-launch[data-mode="recovery"] { color: var(--secondary); }
  .upgrade-launch[data-mode="recovery"] .upgrade-recovery-icon { display: block; }
  #upgrade-description, #upgrade-status { overflow-wrap: anywhere; }
  .theme { position: relative; flex: none; }
  .theme-trigger { display: grid; place-items: center; width: 36px; height: 36px; padding: 0; }
  .theme-trigger[aria-expanded="true"] { color: var(--focus); border-color: var(--focus); }
  .theme-menu { position: absolute; z-index: 3; top: calc(100% + 6px); inset-inline-end: 0; display: grid; gap: 2px;
    min-width: 132px; max-width: calc(100vw - 32px); padding: 5px; border: 1px solid var(--line); border-radius: 10px;
    background: var(--surface); box-shadow: 0 8px 24px rgb(0 0 0 / .22); }
  .theme-menu button { display: flex; justify-content: space-between; align-items: center; gap: 10px;
    min-height: 36px; padding: 5px 10px; border: 0; border-radius: 6px; background: transparent; text-align: start; white-space: nowrap; }
  .theme-menu button:hover, .theme-menu button:focus-visible { background: var(--hover); }
  .theme-menu button[aria-checked="true"] { color: white; background: var(--blue); }
  .theme-menu button[aria-checked="false"] .icon { visibility: hidden; }

  main { width: min(1000px, calc(100% - 48px)); margin: 34px auto 0; padding-bottom: 64px; }
  .page-intro { display: grid; grid-template-columns: minmax(15rem, 1fr) minmax(0, max-content); align-items: center; gap: 28px; }
  .heading h1 { margin: 0 0 6px; font-size: 30px; font-weight: 680; line-height: 1.25; letter-spacing: .01em; }
  .heading p { margin: 0; color: var(--secondary); font-size: 14px; }
  .portal { display: flex; min-width: 0; align-items: center; gap: 10px; min-height: 48px; padding: 6px 7px 6px 12px; background: var(--inset); border: 1px solid var(--line); border-radius: 8px; }
  .portal strong { flex: none; font-size: 14px; font-weight: 550; color: var(--secondary); }
  .portal-value { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex: 1; min-width: 0; }
  .portal code { min-width: 0; color: var(--text); font: 13px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; overflow-wrap: anywhere; }
  .portal .button { flex: none; min-width: 92px; padding-inline: 8px; font-size: 13px; }
  .portal-tools { display: flex; justify-content: flex-end; margin-top: 5px; }
  .portal-tools .button { min-height: 32px; padding-inline: 8px; border-color: transparent; background: transparent; color: var(--secondary); }
  .portal-tools .button:hover { background: var(--hover); color: var(--text); }

  .devices { margin-top: 25px; }
  h2 { margin: 0; font-size: 16px; font-weight: 650; line-height: 1.4; }
  .registry-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 11px; }
  .toolbar { display: grid; grid-template-columns: minmax(0, 2.9fr) minmax(0, 1fr); align-items: stretch; gap: 10px; margin-bottom: 9px; }
  .filters { display: flex; align-items: center; gap: 1px; padding: 2px; min-height: 38px; border: 1px solid var(--rule); border-radius: 7px; background: var(--bg); }
  .filters button { display: inline-flex; align-items: center; gap: 8px; padding: 2px 10px; background: transparent; border-color: transparent; border-radius: 5px; white-space: nowrap; color: var(--secondary); min-height: 32px; }
  .filters button:hover { color: var(--text); background: var(--hover); }
  .filters button[aria-pressed="true"] { border-color: var(--filter-border); background: var(--selected); color: var(--text); }
  .count { display: inline-grid; place-items: center; min-width: 19px; height: 19px; padding-inline: 3px; border: 1px solid var(--line); border-radius: 50%; font-size: 12px; font-variant-numeric: tabular-nums; background: var(--bg); }
  .search { display: flex; align-items: center; gap: 8px; padding: 0 11px; border: 1px solid var(--line); background: var(--inset); border-radius: 7px; }
  .search .icon { color: var(--secondary); }
  .search:focus-within { outline: 2px solid var(--focus); outline-offset: 2px; }
  .search input { border: 0; outline: none; width: 100%; min-width: 0; min-height: 36px; padding: 0; background: transparent; }
  .search input::placeholder { color: var(--secondary); opacity: 1; }

  .table-wrap { border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
  table { width: 100%; border-collapse: collapse; text-align: left; }
  .identity-col { width: 35%; }
  .state-col { width: 24%; }
  th, td { padding-inline: 16px; border-bottom: 1px solid var(--rule); }
  thead th { height: 37px; color: var(--secondary); font-weight: 540; font-size: 13px; }
  tbody th, tbody td { height: 58px; }
  tbody tr:last-child > * { border-bottom: 0; }
  .identity { display: flex; align-items: center; gap: 11px; }
  .initial { display: grid; place-items: center; flex: none; width: 33px; height: 33px; background: var(--inset); border: 1px solid var(--line); border-radius: 7px; font-size: 14px; font-weight: 590; }
  .device-name { display: block; font-size: 14px; font-weight: 640; line-height: 1.25; overflow-wrap: anywhere; }
  .system { display: block; margin-top: 2px; color: var(--secondary); font-size: 12px; font-weight: 400; }
  .state { display: inline-flex; align-items: center; gap: 7px; padding: 2px 7px; border: 1px solid var(--rule); border-radius: 999px; white-space: nowrap; font-size: 12px; }
  .state::before { width: 6px; height: 6px; border-radius: 50%; content: ""; background: var(--disabled); }
  tr[data-state="active"] .state::before { background: var(--active); }
  tr[data-state="pending"] .state::before { background: var(--pending); }
  .row-actions { display: flex; align-items: center; gap: 6px; }
  .row-actions .button { min-height: 30px; padding-inline: 9px; font-size: 13px; }
  .row-actions .quiet { background: transparent; border-color: transparent; color: var(--secondary); }
  .row-actions .quiet:hover { background: var(--hover); color: var(--text); }
  .note { margin: 10px 0 0; color: var(--secondary); font-size: 12px; }
  .empty { display: grid; justify-items: center; gap: 6px; text-align: center; padding: 24px 16px; }
  .empty .icon { color: var(--secondary); width: 25px; height: 25px; }
  .empty p { margin: 0 0 3px; color: var(--secondary); font-size: 13px; }

  dialog { max-width: min(426px, calc(100% - 32px)); width: 100%; color: var(--text); background: var(--surface); border: 1px solid var(--line); border-radius: 11px; padding: 0; }
  dialog::backdrop { background: #0009; }
  .dialog-head { display: flex; align-items: center; justify-content: space-between; padding: 15px 17px 4px; gap: 12px; }
  .dialog-close { display: grid; place-items: center; min-width: 28px; min-height: 28px; padding: 0; border-color: transparent; background: transparent; }
  .dialog-body { padding: 8px 17px 16px; }
  dialog p { margin: 0; color: var(--secondary); }
  dialog label { display: grid; gap: 5px; margin-top: 12px; }
  dialog input { padding: 6px 9px; min-width: 0; }
  .platform-tabs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); min-width: 0; margin: 0; padding: 0; border: 0; border-radius: 7px; background: var(--inset); }
  .platform-tabs label { display: block; position: relative; min-width: 0; margin: 0; cursor: pointer; }
  .platform-tabs label + label::before { position: absolute; inset: 5px auto 5px 0; width: 1px; background: var(--line); content: ""; }
  .platform-tabs span:not(.sr-only) { position: relative; display: grid; place-items: center; min-height: 38px; padding: 4px 6px; border: 1px solid transparent; border-radius: 7px; color: var(--secondary); }
  .platform-tabs label:hover span { color: var(--text); }
  .platform-tabs input:checked + span { z-index: 1; background: var(--surface); border-color: var(--line); color: var(--text); font-weight: 600; }
  .platform-tabs input:disabled + span { opacity: .55; cursor: not-allowed; }
  .platform-tabs input:focus-visible + span { z-index: 2; outline: 2px solid var(--focus); outline-offset: -2px; }
  .field-hint { margin-top: 5px; color: var(--secondary); font-size: 12px; }
  .dialog-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 7px; padding: 11px 17px; border-top: 1px solid var(--rule); background: var(--inset); }
  .dialog-actions .primary { min-height: 34px; }
  .feedback { margin-top: 12px; font-size: 13px; }
  .device-command { padding-top: 7px; }
  .device-command > p { margin-bottom: 12px; font-size: 13px; }
  .device-command h3 { margin: 0; font-size: 14px; font-weight: 650; }
  .device-command pre { margin: 7px 0 12px; padding: 10px 11px; border: 1px solid var(--line); border-radius: 7px; background: var(--inset); color: var(--text); font: 13px/1.65 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
  .device-command .primary { width: 100%; min-height: 40px; }
  #device-command-feedback { margin: 7px 0 0; font-size: 12px; }
  .detail { display: grid; grid-template-columns: max-content minmax(0,1fr); gap: 7px 18px; margin: 10px 0 0; }
  .detail dt { color: var(--secondary); }
  .detail dd { margin: 0; overflow-wrap: anywhere; }
  #device-dialog[data-risk="true"] { max-width: min(360px, calc(100% - 32px)); }
  #device-dialog[data-risk="true"] .dialog-head { justify-content: center; padding-block: 2px 5px; }
  #device-dialog[data-risk="true"] .dialog-close { display: none; }
  #device-dialog[data-risk="true"] .dialog-body { text-align: center; }
  #device-dialog[data-risk="true"] .dialog-actions .button { flex: 1; }
  .risk-mark { display: grid; place-items: center; margin: 16px auto 7px; width: 33px; height: 33px; border-radius: 7px; color: var(--risk); background: var(--risk-bg); }
  .danger { background: var(--risk-bg); color: var(--risk); border-color: transparent; }

  #callback-dialog { max-width: min(652px, calc(100% - 32px)); max-height: calc(100% - 32px); overflow: hidden; }
  #callback-dialog[open], #callback-overview, #callback-form { display: flex; flex-direction: column; min-height: 0; }
  #callback-dialog > .dialog-head, #callback-dialog .dialog-actions { flex: none; }
  .callback-body { overflow: auto; }
  .callback-current { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 11px; margin-bottom: 16px; border: 1px solid var(--rule); border-radius: 7px; background: var(--inset); }
  .callback-current p { font-size: 12px; margin-top: 2px; }
  .callback-current > div { min-width: 0; }
  .callback-tag { display: inline-block; flex: none; border: 1px solid var(--line); padding: 1px 7px; border-radius: 999px; font-size: 12px; color: var(--secondary); }
  .callback-tag[data-tone="pending"] { color: var(--pending); }
  .callback-section + .callback-section { margin-top: 16px; }
  .callback-section h3 { margin: 0; font-size: 14px; font-weight: 620; }
  .callback-section > p { font-size: 12px; }
  .callback-clients { list-style: none; margin: 7px 0 0; padding: 0; border: 1px solid var(--line); border-radius: 8px; }
  .callback-client { display: grid; grid-template-columns: minmax(118px, .32fr) minmax(0, 1fr); gap: 6px 12px; padding: 9px 11px; }
  .callback-client + .callback-client { border-top: 1px solid var(--rule); }
  .callback-identity { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; align-content: start; min-width: 0; overflow-wrap: anywhere; }
  .callback-uris { display: grid; gap: 3px; }
  .callback-uri { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; min-width: 0; }
  .callback-uri span { font-size: 12px; color: var(--secondary); }
  .callback-uri code { max-width: 100%; font: 12px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; overflow-wrap: anywhere; }
  .callback-unset { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px; font-size: 12px; }
  .callback-unset .button { min-height: 28px; padding-inline: 9px; font-size: 12px; }
  #callback-feedback { padding: 7px 10px; margin-bottom: 12px; border: 1px solid var(--line); border-radius: 7px; color: var(--text); font-size: 13px; background: var(--inset); }
  #callback-form input { width: 100%; }
  #callback-form [aria-invalid="true"] { border-color: var(--risk); }
  #callback-form .field-error { margin-top: 3px; font-size: 12px; color: var(--risk); }
  @media (max-width: 540px) {
    .callback-client { grid-template-columns: 1fr; }
  }
  @media (max-width: 860px) {
    .page-intro { grid-template-columns: minmax(0, 1fr); gap: 14px; }
  }
  @media (max-width: 760px) {
    .topbar { padding-inline: 16px; }
    .brand { min-width: 0; flex-wrap: wrap; }
    main { width: calc(100% - 32px); margin-top: 24px; }
    .heading h1 { font-size: 26px; }
    .toolbar { grid-template-columns: 1fr; }
    .filters { flex-wrap: wrap; }
    .filters button { font-size: 13px; padding-inline: 6px; gap: 5px; }
    .portal { flex-direction: column; align-items: flex-start; gap: 7px; padding: 11px 12px; }
    .portal-value { width: 100%; justify-content: space-between; gap: 8px; }
    .portal .button { min-width: 88px; padding-inline: 8px; }
    table, tbody { display: block; }
    colgroup { display: none; }
    thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    tbody tr { display: grid; align-items: center; grid-template-columns: minmax(0,1fr) auto; gap: 8px; padding: 9px 11px; border-bottom: 1px solid var(--rule); }
    tbody tr:last-child { border-bottom: 0; }
    tbody th, tbody td { height: auto; padding: 0; border: 0; }
    tbody td:last-child { grid-column: 1 / -1; }
    .row-actions { justify-content: flex-end; flex-wrap: wrap; gap: 4px; }
    .row-actions .button { font-size: 12px; padding-inline: 6px; }
  }
  @media (max-width: 365px) {
    .portal-value { flex-wrap: wrap; }
    .portal code { flex-basis: 100%; }
    .portal .button { margin-left: auto; }
  }
`;

const logoBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAYKADAAQAAAABAAAAYAAAAACpM19OAAAeM0lEQVR4Aa1ca8xlV1k++5zzfd9c2g6dmXZK7wVK7W3kWiyImmh/kBiNYmKimBgMCS0xRG6FaPSfSmKiERWlBEFKKfw0sTFGKBfDXSiUAAqxDtgCpZ3ptHP7zm37XN537bXPOd/QC7vnrL3W+z7P877rXWvvc/nOtDnnwusHbTto1FTtYABj0wyaFt6lo9G4mDF0PzoYGLFE22FY6Dv4KVb0gSlxE1/8NiwNz2IMARCUccm7zLgZNmPMnwCVSC36qIuyYCMvFSIvqizwlCrtxaOOtRuDnapbaheOi87613SuUZRW/MRbLJGtMsHKkRsHkmTIYiod+MVmY0SdhpwxVwJCreq07ThA9BXAUp8+h9f0G6ZD27qDjs4Z5VIOxUqpJkq4JHEW4YJ0LcqwdIp+sbgju4qDi6FaJHl3IoUGUh2qywLnUffTVk96/dQ6pHoWYaurlgXGwFYlxZH3QjLpNAB2sADzMAWrkbiA5SM11p1FI5AXSXXUcpV5uesCwep0weqpJJxq9qE+Th0xPYXSMUZD8UjSJLlwuF44bdlgjigdmFcArylYSgbAS4Itng5kCpfJDyIKg8BKkz5ZtDVxM6FSHgTW47T3z7jE4qiDpI1naHSu7OnMBkFiz3t+wCIqq6F7mxLIe4k9uZQhkYrUynzTBiFm0DUcMSEcispuxI08bclKgEmDCq0akQkT10BLBi8eCiDXctPqEsu8lr0aUwsAxpEYwRXBYRVP1micNXMo1QG99KVGp1SjCXBl8w6ygRQnwWCkcJR9d9VK1QHodxRsHZMBqQ4mhEe41mLiEktBkzHyI4bMRxs/LgON5SuLjpH2jhlsQYjAsqFPmm3o9b12ENBpB51EMUNAXCFZ/+5QxoxYFqVYbCzQpYUJXRELJjqNdpCLrNwRkTHyQD/ywctOZNP52SspsvxOTaZEFX9Ihn3ZXJTkSK8uMQxAYi3E5RpJq2tlR4MMbSQcPaxBZ+nNy8mQIm7kplPf4Eus+HOPaXX7SJVC4SIHJqCSgA0e0bGPTZQtBR0BjlAQJCcT4WGjuZp/AUAYB4foFCttOEwKaQFtZ33cq43hkwyVKjXAjCwdgsurmOZIAChIsiISJmPw7aKKrCpC9BTP/kKizaa6pWj/sBea3araBBg6iFdtBwwB40PbH/6C5RzioM1qnaaU7K+QnhrnlNw8dwWCRWUBRMEiYkequPIxQdk8J6QfFM6E/VAyL30ZuH8GhrAK6m43b+mFsUinCOwVNa2YSClMhjfMeNvYx46wA/GiwzN3c1egnJ4yUYyAcqPw6MfgGBQahXPXsgpXbqHJSxGM8UBxVV/m4UA8uSfk2qbTEok6icN65ajY6IsLP2EKXmSig7Kw5xJoZwrOanUFoonKVkdbKiZGNHaXDKLgqaw7uYIy3bidFLCCssm04qx6pTOqxSGIPW6sAV3dchjXmShmXSjxArR6CmXIwDBHhvHsXHRoB6q/gxyXLY8i1CVJk/WEUEMJF98c0xASHeektuqSpiGheJoRE6Fz+TB32dqrUCiWKB3F5Ya6LqHOXuScQZdEONIcO6gQ0Sn9SoO22Cu0MmogqWx1OngwGeVDM4kmyyWqbFHoUBGIU2adzODZB0w1LM2MS7hvHhmspqgvQfYsrWwM6rUMvhyYgLgHdSqFxWmUw2S07OQ00PF1pKBlDiZxyJRChieCpYD6amZG2tZBqV94BVLVobMphiNUcYIdQRyVkjjc9gS6gS+FSkgpt9U9yD6KWCi0MR++9sLmR0hoEoLAQEwvPCogdFJIEpG7r3cA4YOvOMVZrOntqRdjiursJEPDq8Ms+lIeIQ6jZc5daK0q5A1jqwIRr6AlQacAQLFEBwFNTk+MsMRAFDT4HMJJv6uFnvxmVF0HC+Elr17qbAtY7wSVdFJQogUgT6VXHOYEAacoi6C1BPpN7iA4YwUYhyQjvQLus02rgokU82dQbgHw9ALOvuG+S2Cg4jqQ1y5iSIvNmq/RAM+g7OUBbUah1xlVndwXxMqpkBz5KAS6uwF6GnQN4I0vMWcB4YTTIKMlughU1LS8k4QRWBBsLiq4qFArHYd2fmxjF4reWenoRlFhalRW+REED1hziwaLFpYnpyF/p1ih0EUOfBSj9kepACMoTPV9EOUVQCQ2ygIcZ8PI4sjRmwwsSIyZIaQKiNTBcwLYwZkHE8LCY6tACYfsIR+yOjHR5BQdMYJFPrUWg8WsJsJtZVwczXAjR9YKTs6H6WYCJLHP/IufsVQgEwPS1Yj+iKaz+syKky/5J8pTtitWxmkRAFFXixoyU0cONiUM+0o6lzKxBkXFA7SYDbf2j8+/cTje40k5ngo6mJ/6wezY/VRuRtKHYq6TcUykmkeRiOQd0QVyglx+bwP6cBQ27NGXdOob1UE5YT5VYnbLzY8xOxH6OeyO3lgSFiGo44mS3vlkfOAl+170zsGeKzod9Uxq5/PtB+859fU/WcxONbzVlhiSCQ6MFOSzqks4FXu0ufcCMGpSBCgoeQNQ4wogK8s480W7PR3M5nSiDtPFYHvG2KN8Nch1hBIegFAyZSGQ3bLcxd05uR3He8598d8Mz3leO28HC6yFH6BHB6uzsf+axfTE7JHPNcMxF6tIMzkenWIO6ktbkAZMJgmyrz1ZSaVcUUylPBcUIbHvkeX2bHjp/l2/cO3mTVc2l+xHUdpjJyZfOTL52Den33hoMB4OXCaJIyoORFEnZDhy6IiwdBKHRZiN9l4xPlfV4TRLpqiOBzS282bz4CtOf/s9CoE0od4rU5kf50tCzqULi7+LMUdlSYHwRJTkgG2tTlHAMmyn8+HerXPe9Ko9v/vK0cX7kSOWVXrN7t94xeD2kyc+8pkT7/yX+Y+eaDbHyr2kwJXh2igLDLgwzENsoqpO3MiU5XCDIIIrDLEscrEOms3yVmaH0hd9C4kesrTwJs2h7RZnOQzhatLmhImP3NXNZjIfXrTv/Pe8duvnrmtn08X2xALYUugw2d0b577ulq2XXX309+6YfeuhZtdmMBXEmCqllI0cMCzJ1NucO0IHzlERJZebSOfU4AS0E9LQcdHTqkT1MxqBlF25NTBshi4dFEmKXAR0YsBzO1805+3e/4+v2/q569vtCe4Iqg7rkipts2jh2jh8xYG73rBxw2XtmYnEipRErWlHocYwQjJcJxtZEJK7jn3rpFrmQIS46SA0DlXSW8Fwt4GMApXlqBIwnzgwOO1iSB2WYTo/7+2/vHXzNe32NkbysHGZgqLxYHu6cfVF53/o1o3Dl7enVSMStD21epobTHjgcKtuGcu27CBSezWxKwDmo3XD2aknVGdNjVd5FRSwQEaBkpfnyG8pVuxSO7Gb2tl847pL9rzm5e102gVnLD0yjVDBNkSNnnMINRq/4PL2zJT2XgRHR2sr2uLWJsFUIkHa2cWzLJ36GVN2gdVUSh2i7rmAxCokQ/PGEpdYaPgORJ+oaj1i10YG5nbztTadbb3qBaPzzm1xERVAAlkm7jEe4QVxezq+8oIDd902fmHWCJIxSYCdCtrysABao7BIxghCecZQ6WQv9YrICaZM3Yc7EPTQVROINDrvQRiqYi5bgGsFCuY0i3002nzhFXjBgg+JFbNCsgk1B/MA89uejS47eOBDt2286Apca5ivtcv2KPQdOoBzPhkOWfGTi8bSAg1+QpiCT5JKBo1G1BFg6R8yqECcOLdEESAdwm6rCDBGGaw2HA32nDtggTzuAtR5hbPTbwaT2ejS/ftxP3rpVYtTeNVDcdB08TuhNT2sxXAwPT6cnyHP+5ncKFKEg2GIDxwPtQte/v1jOVt56+joB2YYKyF9GGlOJPuw6JE2EeHQuJk3zff3srhU6SD9bFhTr7CKSxjjTOajS/af/8HXb9703MWpaQpYZEcpKzfNaH7iuyf/96N4hzwYorZDlkyPZoixHuNhOzl15sjdMdWY71Jq9dCIEjo6o429ByHhfa7UdbV0xBB2TbjMeVCgbbcufPXGLfjQPFcZw+di1ZYkaQE4UNnni+H55+y65YbJF74zO/LoYHOEIitEFaYw+x0AF0e/uNh+rGm2FttH2+0fLU7/cHHm4fbMw2p/ND325ZPf+NPpo58f8DO9ZXnWWjqNmJNW2xGVODPwgyGbvRf8FN/KGiyPzGx0VEyMPXIQuhf7brpz1x+dN7r5gcH2qCq+r04JiJM8WgzjJmLQtt0cLx46+ujvvHv6hQea3ZtVgQCseVbTutAh8nyb32lwI0lKEF2teIO2zTcPQ7yT1hYmXGXyVENYVrKkhlPEDDc4+rCqaBJ3BMLzcJctuX0H7ipbl/568+B1w2uPDg+cGczLLZ/sxPKcfdrLIWPT4K3ms/bsvuWG7c9/Z459NB4FAcsZiZnt3MMpSZRi3M70eXg65ydkP/wWHt9y8IsOHkgbtGD2eix3yS6leY4DFzM/zfuSSCPOAalPXheUROsAD0ltu+vyXxsuLpvff2B0zfGGNTIHbSGXjgIsLwZ0G3wH0Dxr765fun7y2W/Pv3t0sMEaOXfIiG+R0rLTTma442xef8nGK67GG6uNw5fhbfr42oubvZvtoyfb01N+PFYesbRmR2IYRIRMNdzKsjQNLrFrgeTWUJmIKv0+haUpRMPbxb6Xf3C8/6bF9mB4wZnNN94/fO6xdnvIyhEZYiblQDUWXXlzdeHC5YBrbfZ/jxx9zbtn/3kE11oJRbeuEitGsmemWy+56tw//JXNm5832EMw7tIQ5GN7Mr//weN/9s9n/u3rza4NsnHoNTSvII1lXtcodxI44fg+iMNqbQ2hTMh3On0DL7HhnksGw0X7xMbivoPDq59oDp3Ma22ZXbiZAg2eP2fAe/berV+8bvLZ78y/d7TZiAskYiM90Jhkg3fkm698/v4Pv2F8/WUo7GDGj3sDfDGET4K44vAydtmB3b/64tmRR6ZfPdKMca1RQ8Eshq60QnqHk1h51/DugEkPJO1HUon1dCHM6THR/rGxWBzd2v6rw4tvHhhs8UrTmhlDBg5zTVckmwNIwclsfNnB/Xe+nu8h8zNtRNIGhwQ+Hg/3733WX/zW6MA52CyxWS1NPb4zarbxVdB435//5vjqi/B5KAJbiOH5zFbdbghXb2ZZoAJjR7Nzx1Jh7FHzgusQg41Fe3xz+teH268fzBqRicOKbHUvU8ceXVyeAX1Ng/dHl1+A90fjw/jcPyVTEbg8fkymu171gs1rL21RBa8j7DxYwu7lczofX3D+rle/FN9V0UkMhQSwEM2h7i7b0CqGKBCovm3IUeacRShwZ1SG7HhjqYfBeNE+vjl51+HF1y4cbGG3e1K+OzAIH5FDSSWNcePiZ5Hx5QcP3nXbxuFL21Px3QgjMQiPrZc9VyPnqbuDHXkXQhSkhWtv6yXP4SVWzS5FwEXXLf0WyA5cAex2ECdaYIQHIo2VD7HLJWmSnIFAjU5sTN514+IrFw438V6bQtLSGSDjYkFiyXmThoMuSmMfDa/APsJ3I933R0wKgOFw8Kw9+nwjXUpbUZWyBo2sUHPuLryW0aYMBHQPrVkVHV0exc5BFIhwS1PJZI0DjJPtwGWHdB3GqI1ExovBqfHk726cf/nQgDWKXQbFEBWYM+gfHPOJEPjcPxs/58Lz77x1fP2lvNZgN5yl5JGiKiidZiqafyhNBKV8MksqSkQiZKVDBjcwhZUFYlcaETJ9IQwXEUHwi2nYSEQ3UyCK2VMMb25Pj7f/9obFly4abOJve1wKQS0Uap0OVeAi3S2FWaNDuGePr332wvcjwbDDxM8KgyBpEv0nSW1bYalqUULiCTd6HrBVX5E1qJveh1VGhZqCC2SVTg5CxZvZUTxx0RG3HYzwHnc0efcN088farZ0p2ReTCgjkGe2s7M3SmgQvj963kW4Z4+ef4g1wsG52ee9o7mmojwxYCSMi4tDHBgXkyBqOA045CEiIPgELE5hlI4J8goRTfp1gcMGVQr7FNMnlCYYR4PFmeHsH26cfubZ7dYiitGVCWmkoIyca3fQRcP2bOOaiw/cedvoORfyj27cLnHn4mdIIvxEX8PYRZCmvgOUMJ189OQJFO8FGGN/Rib8AVWVEx2OtiJT75fOSfGyjKBWaThnzGTcLraHk/dcv7j3vMGmPhWLLyhBHYejzIxpKEmfcK1de/H+O28dXnmwPTPTX0pFdExiFA+56C9fMT2py0Hl6lCkGKOvslIvcwkOT7jEiOgU0YMhkZVorAVJ8BuQNI24mvJSUIsHIG8WqNGwHT3+x1878f57R5tbdHbZWE93qLKdKKA07NSy8Tv/Gy7FtTa8/MBU7yEhXe4HTIAsQz1gG4XrJhjh4Fs5yCeFrQ8mhD/jaZvGhOFQr2ASq2B04RlpAMMUZUKmpIjbUYi1UouveqaTx99y93Bj7+7ffkUzmehWZ3wwmQmfpECWPiQriFLUJ4yfvnLfB17HL1YW+HDBw/rqxkiWWEFJJASE7Apfj4vDxm6ob1KkXGwi16OSCYxOPPTt0CCLEwWxjbOTEK0j/E11Ojv2xg9i9nte87PtZLuqJ5UiZERgwV0mkMOF8/Z0z888H9+QLKb46EU74S5q5LHzKVUSsTS2niQjIAHxPgi9UnPxmfG6Q+sLom9mOA8j/ZxiITISI+TRLhb8/qFtj/3Bnac++OnhJr7Ksr9QDJWSQsQYFYCtoFAa7Z5KvPgyWJzD3nevBu37ozqSwE26mx+IQHoBSVmildiRmODOPV1iqHQSklk2T5AM/sxjsXjsTR86+U+uUXLjDEyWrR+/jCStpsqQey2r2PcVXoVmN2ahsO7XlswKv5N2QYDv/GFK0PK5CwmPMqtim8t0TePJ6UgfDWuE3XT8TR869YFPYR+VK0iMoIEFqEsVicXJstD03SmGClKCMmYNZ7/cvsmws8QqHfqqA3b9RrGDo6dKxSJyaiYbAm5vCGwiyzSlLx1HErOiUxJfZOpaezNq9OmG11pkZXW2eKa0jRE5gCpfv0bWELescGcjL3Rx8iO1SvhiiA7p/KOJh3HCoNfDAI8QZQgeyKBsOQpQg4/OSIhTMt59Z+61zxqd/MCnBqqRNUI/WTBWh+NnFnJ4AFhsEYz1jRBC6QEQ//5PWE+rilYFSMkuRHeT5oRCQ0p6GelzXYCMIxE2fqL1az05qh8t2vYE0Ng7IRg+l7ft8Tffder9n/L7oxrGGTCHUnQ548Liic48JG191ULdzt/1TChjylQapV8A5VXMaxtoDSKVWkJSvrtIgTgPqZzPyKHOn07HjE2WmaBGeEk6/tYPn3jfJ3CtldfI8GtvIpHMFy8AgHC/RpCuS4Ps+jO0RuAZTJnCMZPZOsiSA8bOAhp+gkcGV9x48wOjEyn21Yi6HzEl1PVrBPoxjJUgzEk3+L5mvjj2lrsQbM9rf34w0TcbeCfI+YmkLNBgkF10Qg86aXfosEdVdXGJxYAVNm0msbW3G7uHS4yKhK9SuDv4BUKPxGmtQpNv54pfZgplsJ4kvgOD6rG33nXyvffq/VF4fetAFn6ArI5kHCIvape9TlRcTgAc8tTrRy1wdPyAv5c6aNU9iFpSKESB2dQKMeCtwf+JA5Rp4qiLngbaKVhx5kgH7dzyPBcO70eDwWNvu/uJOz6Oa61cnzkxc9mqSjzFYSFKZQBl6NBEsbd0iVkNdqmYKenQrE5RoC4e1Sp/Skmpskc5gA10AJh/wopOsQjcjRiqoqNGzeD47Xc/8Z6PDTc3fAFqDhWG7/2LrlJV6hm10zbI1VMfjW0dRonyWmQsXtEwLHn5iwjCwqW+aGoAzmsdHlKX6IZyBfpOoC2ltpAqWxeEUO0nklSjJ97x0RN3fHzAGslBLJ2ic8phhS6lrUqQAqEhOMeyceCjAy/PhZ7KSzi4vMRkRbPkNb6vX0YsSA7irBOboiMLJ+MIVZtkIAQiKWh8D4lr7fa7T95xb32twW0M92iQACwH6Y5gkyFFVoEUbg23iKzxxSVGyBqvklJq1kDXpSnp0G4AfUrROt70qUm8j7TIbzNMssbG8LvX5vG3f8TXWhQG9FAh2By3/EV2BI/VgCGw6Hh9CPGRHp8tkb7q7AmU90HwBBGnlKjg0fWK1H78nL1apoD1qkNBptHO0BZtacBAb2eVm3dovD8atKjRyfd+AvcjmKUAvikcORZD8QpPP7SYkDTRTmZ4DxFZ+RQvDGkDsHdgnOJy5Q6KcMvwjuuggBGSdcJfLU8dCUwoFPmYNeDMFj+xOvV9pJ4owOgp86w6csCj+9Fjb7vr1B2f1P0IVLPRmotxebmLLHgqwMFw8j8P40uo9IGFI7jZz/w0zhAdRgWKofkBXH/yynS+ZvKDf1dCLoIcvtCUCJOhu2mnp+aP3YcvX3O3FTwQnrajd5PHGPdsfP187Pa7Tv79x1AjqTk2KYaqhZofsOZuwlrgH/zc81W+WafZRPO6QVoZLfvGxCh/3cFhjaj7giqRCiNAM1qc+t543w3j867EJwaavNEKLlDN7Pv3nD5yt/6FG0yySlWNhw5QXKokRqgR/q7xsW8MztnavPlqTlSXk9lwZcVtiDrwJXtr1+l7vnzyL/91MBrxtTpWRAwmgAeO0onppcVeIkqBbFotrVUsCEwRIpnHYjY79pWNgy8f7TkYW8F2tUhrOB7OH/uvJ+57x2B+Gluicq7tOgRc6DglnPlxfPLxb+Kb1o2br262NvAxpHIbXKmhFltbky8/cPzW97VPnMY/McrqLCVv/TLlvmTqlQKlYfmcWYZ9ZYhNNDk2efje0a5Dw71XDcdj/8aU7YirNv3hJ07c97bF6Qe1fZbVdx6DWlJHYTnH7U9+a/LFB0aH9o0vPr/ZvatBrPEGfptQPWAZL05Pznz0c8d//wPtD47jRzDaOnXadb/EL8YSNCz8hVlxBrxX6HRi87Kbw6LsafCftbXjfYc3D9w02n2x/xXkYvLI9OiXJo98Cf9kAT811QsR6M5gnU4Xt/aWjBmy3Z7hh1Xj6y4dvfiKzasODfHbMmN1beH3itMjj07/47+n93+X76f4lqoTVcq1WkkGnh0jlgIlekmQqoVc1IsF3kJoW/z7WtSCDC0bbxi4/jdYW5YnjBIsrKKgW0sIOxkPjCyhdbvFT37w4m1dxqsOADeG+pVjTa8A0S2CjgWr8QUZgPyzjxa2RISzD68NViz+rsNaDMrrFCPZ5xf3xOWZ/p4svjao7rgFFhoJxhdCA/yium3zx7DUca0KhfOQGQ06dZQ0x9mwAq69JvqNIhR45L0sJ2ajAqDrMLVi0ASLppph39xlXOwlb2v6Hc0azSSU0Ox4N9qFeujwia2gtRT69TAhNC7ZLeWWMksvKyWJggMfRtthrOVgrIeFstpZhdWaq3hbzFrlJj6S4rrySSCeRdnurF6SqnPwxQKxClQ8KwUC3c4KEpJLdiuuwqoEuu6ThJlQEl2K2MllFQCoMNxUeBS68fVWg2XJC0ulUCJUlyh2EOtfXNkpQqsuQIo34U//vCrliKv2JxljNWFY/IACOrWywXUbUQRCw3duNQFuD83ZOafeO7UlhZ1ZPQ9YHXHlSnACHaBHfVIDc3dSKPbSWSvqr1yZ3VJFlmhLwxV4NdW1cdYZ64h6bYogOK2EW8eX7SxI69dRapViL53a6z5dukkHpmSGDky22hiISqPOrIArf69bg2vHeiLRXDM8+nH7IwmtMdUB1vVB2SmfNXC/ijlMCebOkko9BKCA14iumH48GOrYRXGhYbDmtrg6rzqllZhnq0LJ5+wK1MQbxYLGcKf+kovMp3U4oTqKZWDhXS3c9KO7CluKuRNgNcpOajspZCD92M9yaTrb+SxIuOw9C8bSdU4dWFZ+GsEmSq08ny2lnXx1lJ0wT8K+/D+a3JFS59rNqoIjIed09szgrekxLN/woDx9lbOrVfF73VWWLXXoHuEsA92D4tJfC3NpGEDyaFbDryXuZFyic9iZ0Os+rdj8VGf1VPE75Sl7/f9y3RnY5b8z5hl6+EHBF1ddrsjxqWmfJduzuHaIgQ/f9Dwp4trXlR10n4a52zjeAks5PcOd+3TpT2IHOdGf6L5dXz4HQuvHEsjeJeOTHz59ut8H/dhITz/AOumdyv2TjbIu8lO0ISHfpJ8i75nCfwKF2KnGzzS1Ph+3RRWICT/9iE+J+ZTA/WyXRlB6hmJPgt7oJp2v8iToVry0whKy2ro7Nd/bmQEMOmyXFDQ3edc5Vmduy85YZ7yT32nUqqsWesFf76ip+KsIJlj+eu0/DYPWP4ohamFpYRyiB1jxWmyn+cBrEcOyj1f+okpP2oXSe+6wylA3q4FKRquu1RlF4ag4HAz/H23NUFlexZuaAAAAAElFTkSuQmCC';
export const consoleLogo = Uint8Array.from(atob(logoBase64), char => char.charCodeAt(0));
const consoleLogoUrl = 'data:image/png;base64,' + logoBase64;

export const consoleTemplate = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>设备管理 · Nodrelay</title>
<style nonce="@@NONCE@@">${consoleStyles}</style>
<link rel="icon" type="image/png" href="${consoleLogoUrl}">
</head>
<body>
<svg class="sr-only" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
  <symbol id="moon" viewBox="0 0 24 24"><path d="M12 3c.132 0 .263 0 .393 0a7.5 7.5 0 0 0 7.92 12.446a9 9 0 1 1 -8.313 -12.454l0 .008"></path></symbol>
  <symbol id="sun" viewBox="0 0 24 24"><path d="M8 12a4 4 0 1 0 8 0a4 4 0 1 0 -8 0"></path><path d="M3 12h1m8 -9v1m8 8h1m-9 8v1m-6.4 -15.4l.7 .7m12.1 -.7l-.7 .7m0 11.4l.7 .7m-12.1 -.7l-.7 .7"></path></symbol>
  <symbol id="upgrade-available" viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0"></path><path d="M12 8l-4 4"></path><path d="M12 8v8"></path><path d="M16 12l-4 -4"></path></symbol>
  <symbol id="upgrade-recovery" viewBox="0 0 24 24"><path d="M12 8l0 4l2 2"></path><path d="M3.05 11a9 9 0 1 1 .5 4m-.5 5v-5h5"></path></symbol>
  <symbol id="monitor" viewBox="0 0 24 24"><path d="M3 5a1 1 0 0 1 1 -1h16a1 1 0 0 1 1 1v10a1 1 0 0 1 -1 1h-16a1 1 0 0 1 -1 -1v-10"></path><path d="M7 20h10"></path><path d="M9 16v4"></path><path d="M15 16v4"></path></symbol>
  <symbol id="check" viewBox="0 0 24 24"><path d="M5 12l5 5l10 -10"></path></symbol>
  <symbol id="plus" viewBox="0 0 24 24"><path d="M12 5l0 14"></path><path d="M5 12l14 0"></path></symbol>
  <symbol id="copy" viewBox="0 0 24 24"><path d="M7 9.667a2.667 2.667 0 0 1 2.667 -2.667h8.666a2.667 2.667 0 0 1 2.667 2.667v8.666a2.667 2.667 0 0 1 -2.667 2.667h-8.666a2.667 2.667 0 0 1 -2.667 -2.667l0 -8.666"></path><path d="M4.012 16.737a2.005 2.005 0 0 1 -1.012 -1.737v-10c0 -1.1 .9 -2 2 -2h10c.75 0 1.158 .385 1.5 1"></path></symbol>
  <symbol id="link" viewBox="0 0 24 24"><path d="M9 15l6 -6"></path><path d="M11 6l.463 -.536a5 5 0 0 1 7.071 7.072l-.534 .464"></path><path d="M13 18l-.397 .534a5.068 5.068 0 0 1 -7.127 0a4.972 4.972 0 0 1 0 -7.071l.524 -.463"></path></symbol>
  <symbol id="search" viewBox="0 0 24 24"><path d="M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0"></path><path d="M21 21l-6 -6"></path></symbol>
  <symbol id="close" viewBox="0 0 24 24"><path d="M18 6l-12 12"></path><path d="M6 6l12 12"></path></symbol>
  <symbol id="risk" viewBox="0 0 24 24"><path d="M12 9v4"></path><path d="M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0"></path><path d="M12 16h.01"></path></symbol>
</svg>
<header class="topbar">
  <div class="brand"><img src="${consoleLogoUrl}" width="35" height="35" alt="">Nodrelay
    <button id="open-upgrade" type="button" class="button upgrade-launch" aria-haspopup="dialog" aria-label="升级" title="有新版本可升级" hidden>
      <svg class="icon upgrade-available-icon" aria-hidden="true"><use href="#upgrade-available"></use></svg>
      <svg class="icon upgrade-recovery-icon" aria-hidden="true"><use href="#upgrade-recovery"></use></svg>
    </button>
    <span id="brand-version" class="brand-version" hidden></span>
  </div>
  <div class="theme">
    <button id="theme" type="button" class="theme-trigger" aria-label="外观主题：跟随系统" title="外观主题：跟随系统"
      aria-haspopup="menu" aria-expanded="false" aria-controls="theme-menu">
      <svg class="icon" aria-hidden="true"><use id="theme-icon" href="#monitor"></use></svg>
    </button>
    <div class="theme-menu" id="theme-menu" role="menu" aria-label="外观主题" hidden>
      <button type="button" role="menuitemradio" tabindex="-1" data-theme-option="light" aria-checked="false">浅色<svg class="icon" aria-hidden="true"><use href="#check"></use></svg></button>
      <button type="button" role="menuitemradio" tabindex="-1" data-theme-option="dark" aria-checked="false">深色<svg class="icon" aria-hidden="true"><use href="#check"></use></svg></button>
      <button type="button" role="menuitemradio" tabindex="-1" data-theme-option="system" aria-checked="true">跟随系统<svg class="icon" aria-hidden="true"><use href="#check"></use></svg></button>
    </div>
  </div>
</header>
<main>
  <div class="page-intro">
    <div class="heading">
      <h1>设备管理</h1>
      <p>查看设备接入状态，管理 MCP Portal 的远程访问。</p>
    </div>
    <section class="portal" aria-label="MCP Portal">
      <strong>MCP Portal</strong>
      <div class="portal-value">
        <code id="address" tabindex="-1">@@PORTAL@@</code>
        <button class="button" type="button" id="copy-address"><svg class="icon" aria-hidden="true"><use href="#copy"></use></svg><span>复制地址</span></button>
      </div>
      <span class="sr-only" id="copy-feedback" role="status"></span>
    </section>
  </div>

  <div class="portal-tools">
    <button class="button" type="button" id="open-callbacks" aria-haspopup="dialog"><svg class="icon" aria-hidden="true"><use href="#link"></use></svg>客户端回调配置</button>
  </div>

  <section class="devices" aria-labelledby="devices-title">
    <div class="registry-heading">
      <h2 id="devices-title">设备列表</h2>
      <button class="button primary" type="button" id="add"@@ADD_DISABLED@@><svg class="icon" aria-hidden="true"><use href="#plus"></use></svg>添加设备</button>
    </div>
    <div class="toolbar">
      <div class="filters" role="group" aria-label="按接入状态筛选">
        <button type="button" data-filter="all" aria-pressed="true">全部 <span class="count">@@COUNT_ALL@@</span></button>
        <button type="button" data-filter="active" aria-pressed="false">已注册 <span class="count">@@COUNT_ACTIVE@@</span></button>
        <button type="button" data-filter="pending" aria-pressed="false">待接入 <span class="count">@@COUNT_PENDING@@</span></button>
        <button type="button" data-filter="disabled" aria-pressed="false">停用 <span class="count">@@COUNT_DISABLED@@</span></button>
      </div>
      <label class="search">
        <svg class="icon" aria-hidden="true"><use href="#search"></use></svg>
        <span class="sr-only">搜索设备名称或 ID</span>
        <input type="search" id="device-search" placeholder="搜索设备名称或 ID" autocomplete="off">
      </label>
    </div>
    <div class="table-wrap">
      <table role="table" aria-labelledby="devices-title">
        <colgroup><col class="identity-col"><col class="state-col"><col></colgroup>
        <thead role="rowgroup"><tr role="row"><th scope="col">设备与系统</th><th scope="col">接入状态</th><th scope="col">操作</th></tr></thead>
        <tbody role="rowgroup">@@ROWS@@</tbody>
      </table>
      <div class="empty" id="empty" hidden>
        <svg class="icon" aria-hidden="true"><use href="#search"></use></svg>
        <strong role="status">未找到匹配的设备</strong>
        <p>试试其他设备名称，或清除筛选。</p>
        <button class="button" type="button" id="clear-filters">清除筛选</button>
      </div>
    </div>
    <p class="note" role="status" id="device-list-feedback"></p>
    <button id="retry-device-list" class="button" type="button" hidden>重试刷新列表</button>
    <p class="note">注册状态不代表设备实时在线。请通过「查看状态」检查 Tunnel 与 MCP 工具目录。</p>
  </section>
</main>

<dialog id="add-dialog" aria-labelledby="add-title" data-any-system="@@ANY_SYSTEM@@" data-browser-consent="@@BROWSER_CONSENT@@">
  <header class="dialog-head">
    <h2 id="add-title">添加设备</h2>
    <button type="submit" form="close-add" class="dialog-close" aria-label="关闭弹层"><svg class="icon" aria-hidden="true"><use href="#close"></use></svg></button>
  </header>
  <form id="add-device-form" method="post" action="/admin/devices/reserve">
    <div class="dialog-body">
      <label>设备名称 <input name="name" required autofocus placeholder="例如：办公室 Mac" autocomplete="off" aria-describedby="name-hint"></label>
      <p class="field-hint" id="name-hint">最多 20 个字，设备 ID 由系统自动生成。</p>
      <p class="feedback" id="add-feedback" role="status" hidden></p>
    </div>
    <div class="dialog-actions"><button class="button" type="submit" form="close-add">取消</button><button class="button primary" type="submit" id="save-device">添加设备</button></div>
  </form>
  <form id="setup-device-form" method="post" action="/admin/devices" hidden>
    <div class="dialog-body">
      <p><strong id="setup-device-target"></strong> · <span id="setup-device-hint">选择目标设备的操作系统。</span></p>
      <input type="hidden" name="deviceId">
      <fieldset class="platform-tabs"><legend class="sr-only">目标系统</legend>@@PLATFORMS@@</fieldset>
      <label id="browser-consent" hidden><span><input id="confirm-browser" name="browserConsent" type="checkbox" value="1" aria-describedby="browser-consent-hint" disabled> 为此设备启用浏览器工具</span>
        <span class="field-hint" id="browser-consent-hint">安装前需在目标设备配置浏览器专用后端。</span></label>
      <p class="feedback" id="setup-feedback" role="status" hidden></p>
    </div>
    <div class="dialog-actions"><button class="button" type="submit" form="close-add">取消</button><button class="button primary" type="submit" id="issue-command">生成安装命令</button></div>
  </form>
  <section class="dialog-body device-command" id="device-command-result" aria-labelledby="device-command-label" hidden>
    <p><strong id="device-command-target"></strong> · <span id="command-instructions"></span></p>
    <fieldset class="platform-tabs" id="device-command-systems" hidden><legend class="sr-only">目标系统</legend></fieldset>
    <h3 id="device-command-label">指令</h3>
    <pre id="device-command" tabindex="0" aria-labelledby="device-command-label"></pre>
    <button class="button primary" type="button" id="copy-device-command"><svg class="icon" aria-hidden="true"><use href="#copy"></use></svg><span>复制</span></button>
    <p id="device-command-feedback" role="status" hidden></p>
    <p id="device-command-expiration" class="field-hint"></p>
    <p id="device-enrollment-progress" class="feedback" role="status" tabindex="-1"></p>
  </section>
  <form id="close-add" method="dialog"></form>
</dialog>

<dialog id="device-dialog" aria-labelledby="device-dialog-title">
  <span class="risk-mark" id="risk-mark" hidden><svg class="icon" aria-hidden="true"><use href="#risk"></use></svg></span>
  <header class="dialog-head">
    <h2 id="device-dialog-title"></h2>
    <button type="submit" form="close-detail" class="dialog-close" aria-label="关闭弹层"><svg class="icon" aria-hidden="true"><use href="#close"></use></svg></button>
  </header>
  <div class="dialog-body">
    <p id="device-summary"></p>
    <dl class="detail" id="device-details">
      <dt>最后检查</dt><dd id="checked-detail">未查询</dd>
      <dt>注册</dt><dd id="registration-detail"></dd>
      <dt>Cloudflare Tunnel</dt><dd id="tunnel-detail">未查询</dd>
      <dt>开发工具目录</dt><dd id="mcp-detail">未查询</dd>
      <dt id="browser-label" hidden>浏览器工具目录</dt><dd id="browser-detail" hidden></dd>
      <dt id="release-label" hidden>安装包版本</dt><dd id="release-detail" hidden></dd>
      <dt id="revocation-label" hidden>撤销</dt><dd id="revocation-detail" hidden></dd>
      <dt id="server-label" hidden>Portal 服务 ID</dt><dd id="server-detail" hidden></dd>
    </dl>
    <p class="feedback" id="device-feedback" role="status"></p>
  </div>
  <form class="dialog-actions" id="close-detail" method="dialog">
    <button class="button" id="detail-dismiss">关闭</button>
    <button class="button danger" id="detail-confirm" type="button" disabled hidden></button>
  </form>
</dialog>

<dialog id="callback-dialog" aria-labelledby="callback-title">
  <header class="dialog-head">
    <h2 id="callback-title">客户端回调配置</h2>
    <button type="submit" form="close-callbacks" class="dialog-close" aria-label="关闭回调配置"><svg class="icon" aria-hidden="true"><use href="#close"></use></svg></button>
  </header>
  <div id="callback-overview">
    <div class="dialog-body callback-body">
      <div class="callback-current">
        <div><strong>实际配置</strong><p id="callback-summary">正在读取 Portal 中的配置…</p></div>
        <span class="callback-tag" id="callback-state">读取中</span>
      </div>
      <p id="callback-feedback" role="status" tabindex="-1" hidden></p>
      <button id="retry-callback-read" class="button" type="button" hidden>重试读取回调设置</button>
      <section class="callback-section" id="callback-configured" aria-labelledby="callback-configured-title" hidden>
        <h3 id="callback-configured-title">已设回调地址</h3>
        <p>由 Portal 返回，可供 OAuth 客户端注册使用。</p>
        <ul id="callback-configured-list" class="callback-clients"></ul>
      </section>
      <section class="callback-section" id="callback-presets" aria-labelledby="callback-presets-title">
        <h3 id="callback-presets-title">预置回调规则</h3>
        <p>按客户端核对预置规则和 Portal 的配置状态。</p>
        <ul class="callback-clients">
          <li class="callback-client" data-preset-name="ChatGPT">
            <strong class="callback-identity">ChatGPT</strong>
            <div class="callback-uris">
              <div class="callback-uri"><span>固定回调（适用时）</span><code data-callback-address>https://chatgpt.com/connector_platform_oauth_redirect</code></div>
              <div class="callback-uri"><span>按连接分配 · 模板</span><code data-callback-address="https://chatgpt.com/connector/oauth/*">https://chatgpt.com/connector/oauth/{callback_id}</code></div>
            </div>
          </li>
          <li class="callback-client" data-preset-name="Claude">
            <strong class="callback-identity">Claude</strong>
            <div class="callback-uri"><span>自定义连接器</span><code data-callback-address>https://claude.ai/api/mcp/auth_callback</code></div>
          </li>
          <li class="callback-client" data-preset-name="Cursor">
            <strong class="callback-identity">Cursor</strong>
            <div class="callback-uris">
              <div class="callback-uri"><span>网页与 Agents</span><code data-callback-address>https://www.cursor.com/agents/mcp/oauth/callback</code></div>
              <div class="callback-uri"><span>桌面</span><code data-callback-address>http://localhost:8787/callback</code></div>
              <div class="callback-uri"><span>原生协议</span><code data-callback-address>cursor://anysphere.cursor-mcp/oauth/callback</code></div>
            </div>
          </li>
          <li class="callback-client" data-preset-name="VS Code">
            <strong class="callback-identity">VS Code</strong>
            <div class="callback-uris">
              <div class="callback-uri"><span>网页</span><code data-callback-address>https://vscode.dev/redirect</code></div>
              <div class="callback-uri"><span>桌面</span><code data-callback-address>http://127.0.0.1:33418/</code></div>
            </div>
          </li>
          <li class="callback-client">
            <div class="callback-identity"><strong>WorkBuddy</strong><span class="callback-tag" id="workbuddy-state" data-tone="pending">待配置</span></div>
            <div class="callback-unset"><p>没有已验证的通用地址，请填写客户端提供的准确回调。</p><button class="button" type="button" id="add-workbuddy" data-client="WorkBuddy" disabled>填写 WorkBuddy 回调</button></div>
          </li>
        </ul>
      </section>
    </div>
    <div class="dialog-actions">
      <button class="button" type="submit" form="close-callbacks">关闭</button>
      <button class="button primary" type="button" id="add-client" disabled><svg class="icon" aria-hidden="true"><use href="#plus"></use></svg>添加其他客户端</button>
    </div>
  </div>
  <form id="callback-form" novalidate hidden>
    <div class="dialog-body callback-body">
      <p>输入客户端提供的准确地址。保存后，此 Portal 可接受使用该回调地址的 OAuth 客户端注册。</p>
      <label for="callback-name">客户端名称</label>
      <input id="callback-name" name="clientName" type="text" autocomplete="off" maxlength="64" required aria-describedby="callback-name-error">
      <p id="callback-name-error" class="field-error" role="alert" hidden></p>
      <label for="callback-url">回调地址</label>
      <input id="callback-url" name="redirectUri" type="text" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="2048" placeholder="https://client.example/oauth/callback" required aria-describedby="callback-url-hint callback-url-error">
      <p id="callback-url-hint" class="field-hint">填写完整回调 URL，不要粘贴授权码或密钥。</p>
      <p id="callback-url-error" class="field-error" role="alert" hidden></p>
      <p id="callback-save-error" class="field-error" role="alert" hidden></p>
    </div>
    <div class="dialog-actions">
      <button class="button" type="button" id="cancel-callback">取消</button>
      <button class="button primary" id="save-callback" type="submit">保存</button>
    </div>
  </form>
  <form id="close-callbacks" method="dialog"></form>
</dialog>

<dialog id="upgrade-dialog" aria-labelledby="upgrade-title" aria-describedby="upgrade-description">
  <header class="dialog-head"><h2 id="upgrade-title">升级诺联管理台</h2>
    <button type="submit" form="close-upgrade" class="dialog-close" aria-label="关闭升级"><svg class="icon" aria-hidden="true"><use href="#close"></use></svg></button>
  </header>
  <div class="dialog-body">
    <p id="upgrade-description"></p>
    <p id="upgrade-status" class="feedback" role="status"></p>
  </div>
  <form class="dialog-actions" id="close-upgrade" method="dialog">
    <button class="button" id="close-upgrade-button" type="submit">关闭</button>
    <button class="button primary" id="reconcile-upgrade" type="button" hidden>核对实际状态</button>
    <button class="button primary" id="confirm-upgrade" type="button" hidden>确认升级</button>
  </form>
</dialog>
<script nonce="@@NONCE@@">@@SCRIPT@@</script>
</body>
</html>
`;
