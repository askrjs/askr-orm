# Performance contract

`npm run bench` compares raw adapter execution with generated CRUD and a
prepared builder, then exercises a 10,000-row chunked insert. The gate requires:

- exactly one adapter call per raw, CRUD, or prepared execution;
- no description or AST-rebuild round trip during prepared execution;
- exactly ten adapter calls for 10,000 rows at a chunk size of 1,000;
- generated CRUD orchestration below the deliberately broad 60x microbenchmark
  ceiling used to catch accidental algorithmic regressions.

The command emits one JSON object so measurements can be retained by CI. Wall
clock values are diagnostic because runner and driver latency vary; adapter
call counts are the stable regression contract.
