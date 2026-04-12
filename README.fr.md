[English](README.md) | [Chinese](README.zh-CN.md) | [Japanese](README.ja.md) | [Español](README.es.md) | [Français](README.fr.md)

# Rin

Rin est un assistant IA local, centré sur le terminal, qui reste utile d’un tour à l’autre.

Il peut discuter, modifier des fichiers, mémoriser des préférences durables, chercher sur le web, exécuter des tâches planifiées et se connecter à des plateformes de chat via Koishi, le tout derrière une seule entrée : `rin`.

## À quoi sert Rin

Rin s’adresse à celles et ceux qui veulent garder un assistant dans leur flux de travail quotidien, au lieu de rouvrir un agent jetable à chaque fois.

Utilisez-le pour :

- inspecter et modifier un dépôt depuis le terminal
- conserver une mémoire stable et des compétences réutilisables
- programmer des rappels et des vérifications récurrentes
- consulter des informations récentes sans quitter le flux de travail
- continuer avec le même assistant depuis le terminal et le chat

## État actuel du projet

Rin est déjà utilisable, mais reste un produit en cours de raffinement actif.

La direction principale est déjà stable :

- workflow local-first
- mémoire et rappel intégrés
- tâches planifiées intégrées
- recherche web et fetch intégrés
- prise en charge du pont de chat Koishi
- chemin cohérent d’installation, d’exécution et de mise à jour

Mais la fiabilité, l’UX et la documentation continuent d’être polies. Si vous l’essayez aujourd’hui, pensez à un produit en évolution plutôt qu’à une plateforme figée.

## Démarrage rapide

Installation :

```bash
./install.sh
```

Ouvrir Rin :

```bash
rin
```

Vérifier l’état si nécessaire :

```bash
rin doctor
```

## Commandes principales

```bash
rin            # ouvrir Rin
rin doctor     # vérifier l’état et la configuration
rin start      # démarrer le daemon
rin stop       # arrêter le daemon
rin restart    # redémarrer le daemon
rin update     # mettre à jour le runtime Rin installé
```

## Ce que vous pouvez demander à Rin

Exemples :

- `Parcours ce répertoire et dis-moi ce qui est important.`
- `Réécris ce README.`
- `Nettoie ce fichier de configuration.`
- `Souviens-toi que je préfère des réponses courtes.`
- `Rappelle-moi demain après-midi de vérifier les logs.`
- `Cherche la documentation officielle la plus récente pour cet outil.`
- `Surveille ce dossier toutes les heures et dis-moi s’il change.`

## Capacités intégrées

Rin inclut par défaut :

- mémoire et rappel à long terme
- tâches planifiées et rappels
- recherche web en direct
- récupération directe d’URL
- subagents
- pont de chat Koishi

## Mettre à jour Rin

Pour un runtime installé normalement, utilisez :

```bash
rin update
```

Si `rin` est absent sur le compte actuel, ne supposez pas que Rin n’est pas installé. Cela signifie souvent simplement que l’utilisateur shell courant n’est pas le propriétaire du launcher.

Pour le flux complet de récupération ou de mise à jour, voir :

- [`docs/user/getting-started.md`](docs/user/getting-started.md)
- [`docs/development.md`](docs/development.md)

## Documentation

Documentation orientée utilisateur :

- [`docs/user/getting-started.md`](docs/user/getting-started.md)
- [`docs/development.md`](docs/development.md)
- [`CONTRIBUTING.md`](CONTRIBUTING.md)
- [`docs/architecture.md`](docs/architecture.md)

Documentation agent / runtime :

- [`docs/rin/README.md`](docs/rin/README.md)
- [`docs/rin/docs/capabilities.md`](docs/rin/docs/capabilities.md)
- [`docs/rin/docs/runtime-layout.md`](docs/rin/docs/runtime-layout.md)
- [`docs/rin/docs/builtin-extensions.md`](docs/rin/docs/builtin-extensions.md)

## Version courte

Installez-le, lancez `rin`, et gardez l’assistant dans votre flux de travail.

C’est le cœur de Rin.
