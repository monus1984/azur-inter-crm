# Azur Inter CRM

Front du Lot 1 : Dashboard et Ventes en lecture seule, connectés à Supabase.
Voir `PROJECT_CONTEXT.md` (à la racine du dépôt, à copier depuis les livrables
du projet) pour l'architecture complète et les décisions prises.

## Mise en route locale

```bash
npm install
cp .env.example .env
# éditer .env avec les valeurs de Project Settings > API dans Supabase
npm run dev
```

## Déploiement Cloudflare Pages

Build command : `npm run build`
Output directory : `dist`

Variables d'environnement à définir dans Cloudflare Pages (Settings ×
Environment variables), identiques à celles du `.env` local :
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

## Créer un premier utilisateur

Le schéma Lot 1 (`schema_lot1.sql`) crée les tables et les politiques RLS,
mais pas d'utilisateur. Pour se connecter :

1. Dans Supabase, **Authentication > Users > Add user**, créer un compte
   (email + mot de passe)
2. Copier l'UUID généré
3. Dans **SQL Editor**, insérer le profil correspondant :

```sql
insert into profiles (id, nom, role)
values ('<uuid-copié>', 'Mounir', 'admin');
```

Sans cette ligne, le compte peut se connecter mais l'application affichera
"aucun profil associé" — c'est la table `profiles`, pas `auth.users`, qui
porte le rôle et les droits.
