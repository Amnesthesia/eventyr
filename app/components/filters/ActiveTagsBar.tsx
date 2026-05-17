import { X } from "lucide-react";
import { useEventsContext } from "../../context";

export default function ActiveTagsBar() {
	const { activeTags, toggleTag } = useEventsContext();

	if (activeTags.length === 0) return null;

	return (
		<div className="active-tags-bar">
			<span className="active-tags-label">tags</span>
			{activeTags.map((tag) => (
				<button
					type="button"
					key={tag}
					className="active-tag-chip"
					onClick={() => toggleTag(tag)}
					aria-label={`Remove tag ${tag}`}
				>
					{tag}
					<X size={9} />
				</button>
			))}
		</div>
	);
}
