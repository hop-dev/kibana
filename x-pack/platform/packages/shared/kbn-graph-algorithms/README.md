# @kbn/graph-algorithms

Graph algorithms over directed edges with string ids and a kind: the multi-seed walk back from many seeds at once, dominators (Lengauer-Tarjan) and choke points. It knows graphs, not entities, relationships or any index. A caller wraps its own store as an `EdgeReader`.

Unrelated to the Graph app (`@kbn/graph-plugin`).
