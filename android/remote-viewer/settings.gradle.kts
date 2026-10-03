// Amatista -- visor remoto de SOLO LECTURA para Android (Fase 0). Proyecto separado del codigo de Electron.
// Ver docs/_experiments/remote-control/CONTRACT.md (§8 puente de la PC, §9 esta app).
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "AmatistaRemoteViewer"
include(":app")
