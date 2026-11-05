ALTER TABLE projects ADD COLUMN format TEXT NOT NULL DEFAULT 'long' CHECK(format IN ('long','short'));
ALTER TABLE projects ADD COLUMN setup_completed INTEGER NOT NULL DEFAULT 1 CHECK(setup_completed IN (0,1));
