-- Profile pictures: the hash of the person's Discord avatar, saved when they sign in with Discord.
-- The picture itself is fetched by the service on request and served to the person and their friends,
-- so friends never see the Discord account number that is part of Discord's picture address.
ALTER TABLE users ADD COLUMN avatar TEXT NOT NULL DEFAULT '';
