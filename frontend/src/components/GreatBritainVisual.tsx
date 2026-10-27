
import './GreatBritainVisual.css'

export default function GreatBritainVisual() {
    return (
        <figure className="gb-visual" aria-label="Decorative outline of Great Britain">
            <div className="gb-visual__glow" aria-hidden="true" />

            <img
                className="gb-visual__map"
                src="/images/great-britain.svg"
                alt=""
                aria-hidden="true"
            />

            <figcaption className="gb-visual__caption">
                <span className="gb-visual__status" />
                <span>GREAT BRITAIN</span>
                <span className="gb-visual__separator">/</span>
                <span>NATIONAL WIND</span>
            </figcaption>
        </figure>
    )
}
