# TODO

Points ouverts, vérifiés dans le code (novembre 2026).

## Sécurité

- Le rôle est figé à la connexion : un changement de groupe côté IdP ne
  s'applique qu'à la session suivante (durée : `session_ttl`).

## Architecture

- Sessions, comptes locaux et rate limiter en mémoire : une seule réplique,
  sessions perdues au redémarrage. Un store partagé (Redis, Postgres)
  serait nécessaire pour plusieurs répliques.
- Le broker SSE diffuse tous les événements à tous les abonnés ; le filtrage
  par store se fait côté navigateur.
- `GET /api/tuples` lit tout le store (pas de pagination côté UI).

## Tests et CI

- Captures d'écran de `docs/screenshots/` régénérées à la main
  (`scripts/take-screenshots.mjs`).
