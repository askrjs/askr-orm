if (!process.env.ASKR_ORM_TEST_DATABASE_URL || !process.env.ASKR_ORM_TEST_SHADOW_URL)
  throw new Error(
    "PostgreSQL integration requires explicit isolated target and disposable scratch URLs in ASKR_ORM_TEST_DATABASE_URL and ASKR_ORM_TEST_SHADOW_URL.",
  );
