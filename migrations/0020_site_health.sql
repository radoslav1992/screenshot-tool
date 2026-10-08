-- Site health (src/lib/site-health.ts): uptime, SSL certificate, domain
-- registration and broken links for the sites behind each account's monitors.
--
-- site_health_sites has one row per account and site origin (scheme://host),
-- kept in step with the account's active monitors by the hourly sweep. `url`
-- is the oldest active monitor's page on that origin, the one uptime fetches.
-- `active` is 0 once no active monitor uses the origin; the row keeps its last
-- results and is checked again if one does. Each check has its own next_*_at,
-- and the sweeps take what is due through the three *_due indexes.
--
-- Uptime keeps the last answer on the site row, how many checks in a row were
-- down and since when, and the open incident if there is one. Every check adds
-- to its hour's row in site_uptime_hourly, so a month's uptime is a few hundred
-- small rows. An incident opens after two down checks in a row and closes on
-- the first one that is up; opened_alert_at and closed_alert_at claim its two
-- emails. ssl_alert and domain_alert name the last warning sent (a level and
-- the date it was about), so each is sent once per change of state.
--
-- site_link_checks has one row per monitored page: when its links were last
-- checked and what was found. site_broken_links holds each time a link was
-- broken: when it was first and last seen so, and fixed_at once a later check
-- finds it working or gone from the page, which is what "fixed this month"
-- counts. A link that breaks again after a fix gets a new row, so the fix
-- stays counted; at most one row per page and link is open (fixed_at NULL).
--
-- Rollups, incidents and fixed links are kept for 13 months. Additive: until
-- these tables exist nothing is checked and the monitor page shows no panel.
CREATE TABLE IF NOT EXISTS site_health_sites (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 origin TEXT NOT NULL,
 url TEXT NOT NULL,
 active INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL,
 uptime_next_at TEXT NOT NULL,
 uptime_state TEXT CHECK(uptime_state IN ('up','down','error')),
 uptime_code INTEGER,
 uptime_ms INTEGER,
 uptime_detail TEXT,
 uptime_checked_at TEXT,
 uptime_fails INTEGER NOT NULL DEFAULT 0,
 uptime_down_since TEXT,
 uptime_incident_id TEXT,
 ssl_next_at TEXT NOT NULL,
 ssl_status TEXT CHECK(ssl_status IN ('ok','expiring','expired','invalid','no_https','unknown')),
 ssl_valid_to TEXT,
 ssl_issuer TEXT,
 ssl_names TEXT,
 ssl_detail TEXT,
 ssl_checked_at TEXT,
 ssl_alert TEXT,
 domain_next_at TEXT NOT NULL,
 domain_name TEXT,
 domain_status TEXT CHECK(domain_status IN ('ok','expiring','expired','unknown')),
 domain_expires_at TEXT,
 domain_registrar TEXT,
 domain_detail TEXT,
 domain_checked_at TEXT,
 domain_alert TEXT,
 PRIMARY KEY (user_id, origin)
);
-- The three sweeps: active sites by when each check is next due.
CREATE INDEX IF NOT EXISTS site_health_uptime_due ON site_health_sites(active, uptime_next_at);
CREATE INDEX IF NOT EXISTS site_health_ssl_due ON site_health_sites(active, ssl_next_at);
CREATE INDEX IF NOT EXISTS site_health_domain_due ON site_health_sites(active, domain_next_at);

-- One row per site and hour: checks made, how many were down, and their total response time.
CREATE TABLE IF NOT EXISTS site_uptime_hourly (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 origin TEXT NOT NULL,
 hour TEXT NOT NULL,
 checks INTEGER NOT NULL DEFAULT 0,
 down INTEGER NOT NULL DEFAULT 0,
 total_ms INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY (user_id, origin, hour)
);

CREATE TABLE IF NOT EXISTS site_uptime_incidents (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 origin TEXT NOT NULL,
 started_at TEXT NOT NULL,
 ended_at TEXT,
 detail TEXT NOT NULL DEFAULT '',
 opened_alert_at TEXT,
 closed_alert_at TEXT
);
-- A site's incidents in a window: the monitor page and the care report.
CREATE INDEX IF NOT EXISTS site_uptime_incidents_site ON site_uptime_incidents(user_id, origin, started_at);

CREATE TABLE IF NOT EXISTS site_link_checks (
 watch_id TEXT PRIMARY KEY REFERENCES watches(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL,
 next_at TEXT NOT NULL,
 checked_at TEXT,
 page_url TEXT,
 checked INTEGER NOT NULL DEFAULT 0,
 broken INTEGER NOT NULL DEFAULT 0,
 unverified INTEGER NOT NULL DEFAULT 0,
 detail TEXT
);
-- The weekly link sweep, by when each page is due.
CREATE INDEX IF NOT EXISTS site_link_checks_due ON site_link_checks(next_at);

CREATE TABLE IF NOT EXISTS site_broken_links (
 watch_id TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
 url TEXT NOT NULL,
 user_id TEXT NOT NULL,
 status INTEGER,
 reason TEXT NOT NULL,
 link_text TEXT NOT NULL DEFAULT '',
 first_seen_at TEXT NOT NULL,
 last_seen_at TEXT NOT NULL,
 fixed_at TEXT,
 PRIMARY KEY (watch_id, url, first_seen_at)
);
-- Pruning fixed links after 13 months.
CREATE INDEX IF NOT EXISTS site_broken_links_fixed ON site_broken_links(fixed_at);
