import './AppNavigation.css'

export type AppScreen =
    | 'overview'
    | 'scenario'
    | 'accuracy'
    | 'hourly'
    | 'methodology'

interface AppNavigationProps {
    activeScreen: AppScreen
    onNavigate: (screen: AppScreen) => void
}

const navigationItems: {
    id: AppScreen
    label: string
    description: string
}[] = [
        {
            id: 'overview',
            label: 'Overview',
            description: 'Decision summary',
        },
        {
            id: 'scenario',
            label: 'Scenario Explorer',
            description: 'Configure an analysis',
        },
        {
            id: 'accuracy',
            label: 'Accuracy Analysis',
            description: 'Explore forecast errors',
        },
        {
            id: 'hourly',
            label: 'Hourly Data',
            description: 'Inspect individual hours',
        },
        {
            id: 'methodology',
            label: 'Data & Methodology',
            description: 'Sources and calculation rules',
        },
    ]

export default function AppNavigation({
    activeScreen,
    onNavigate,
}: AppNavigationProps) {
    return (
        <nav className="app-navigation" aria-label="Main navigation">
            {navigationItems.map(item => (
                <button
                    key={item.id}
                    type="button"
                    className={`navigation-item ${activeScreen === item.id ? 'is-active' : ''
                        }`}
                    aria-current={
                        activeScreen === item.id ? 'page' : undefined
                    }
                    onClick={() => onNavigate(item.id)}
                >
                    <span className="navigation-label">{item.label}</span>
                    <span className="navigation-description">
                        {item.description}
                    </span>
                </button>
            ))}
        </nav>
    )
}
