PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  user_id  TEXT PRIMARY KEY,
  timezone TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS games (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id     TEXT NOT NULL,
  name         TEXT NOT NULL,
  min_players  INTEGER NOT NULL CHECK (min_players >= 1),
  max_players  INTEGER,
  created_by   TEXT NOT NULL,
  link         TEXT,
  CHECK (max_players IS NULL OR max_players >= min_players)
);

CREATE UNIQUE INDEX IF NOT EXISTS games_guild_name
  ON games (guild_id, lower(name));

CREATE TABLE IF NOT EXISTS nights (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id          TEXT NOT NULL,
  channel_id        TEXT NOT NULL,
  message_id        TEXT,
  host_id           TEXT NOT NULL,
  title             TEXT NOT NULL,
  display_tz        TEXT NOT NULL,
  min_session_hours INTEGER NOT NULL,
  deadline_utc      INTEGER NOT NULL,
  status            TEXT NOT NULL
                    CHECK (status IN ('draft','open','locked','failed','cancelled')),
  voice_channel_id  TEXT,
  locked_start_utc  INTEGER,
  locked_end_utc    INTEGER,
  locked_game_id    INTEGER REFERENCES games(id),
  event_id          TEXT,
  failure_reason    TEXT,
  created_utc       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS nights_due ON nights (status, deadline_utc);

-- One open night per channel, enforced by the database rather than by a
-- check at /gamenight create. Two hosts (or one host running create twice)
-- each hold their own ephemeral setup message and can both press Post it;
-- without this the channel ends up with two live polls, two deadline
-- sweeps, two Scheduled Events, and a cancel that can only ever reach one
-- of them. Partial, so drafts and finished nights are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS nights_one_open_per_channel
  ON nights (channel_id) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS night_days (
  night_id         INTEGER NOT NULL REFERENCES nights(id) ON DELETE CASCADE,
  day_index        INTEGER NOT NULL,
  window_start_utc INTEGER NOT NULL,
  window_end_utc   INTEGER NOT NULL,
  PRIMARY KEY (night_id, day_index)
);

CREATE TABLE IF NOT EXISTS night_games (
  night_id INTEGER NOT NULL REFERENCES nights(id) ON DELETE CASCADE,
  game_id  INTEGER NOT NULL REFERENCES games(id),
  PRIMARY KEY (night_id, game_id)
);

CREATE TABLE IF NOT EXISTS availability (
  night_id INTEGER NOT NULL REFERENCES nights(id) ON DELETE CASCADE,
  user_id  TEXT NOT NULL,
  utc_hour INTEGER NOT NULL,
  PRIMARY KEY (night_id, user_id, utc_hour)
);

CREATE TABLE IF NOT EXISTS game_votes (
  night_id INTEGER NOT NULL REFERENCES nights(id) ON DELETE CASCADE,
  user_id  TEXT NOT NULL,
  game_id  INTEGER NOT NULL REFERENCES games(id),
  PRIMARY KEY (night_id, user_id, game_id)
);

CREATE TABLE IF NOT EXISTS attendance (
  night_id INTEGER NOT NULL REFERENCES nights(id) ON DELETE CASCADE,
  user_id  TEXT NOT NULL,
  status   TEXT NOT NULL CHECK (status IN ('in','out')),
  PRIMARY KEY (night_id, user_id)
);
