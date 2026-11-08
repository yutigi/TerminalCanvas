const { createWorkspace, validateWorkspace, validateCard } = require('./workspace.cjs');

// Keep host-observed metadata authoritative over debounced renderer snapshots.
class WorkspaceRecovery {
    constructor({ save, onError = () => {} }) {
        this.save = save;
        this.onError = onError;
        this.reset(createWorkspace());
        this.pending = Promise.resolve();
    }
    reset(board) {
        this.board = validateWorkspace(board);
        this.metadata = new Map();
    }
    merge(raw) {
        const board = validateWorkspace(raw);
        for (const card of board.cards) {
            const metadata = this.metadata.get(card.id);
            if (metadata) {
                card.cwd = metadata.cwd;
                if (metadata.session) card.session = metadata.session;
            }
        }
        return board;
    }
    accept(raw) { this.board = this.merge(raw); return this.board; }
    rememberCard(raw) {
        const card = validateCard(raw);
        const existing = this.board.cards.find(c => c.id === card.id);
        if (!existing) this.accept({ ...this.board, cards: [...this.board.cards, card] });
        return this.board.cards.find(c => c.id === card.id);
    }
    update(id, metadata) {
        const card = this.board.cards.find(c => c.id === id);
        if (!card) return;
        this.metadata.set(id, metadata);
        this.accept(this.board);
        this.persist().catch(this.onError);
    }
    persist(raw = this.board) {
        const board = this.accept(raw);
        // save() snapshots before queueing its atomic write.
        const pending = this.save(board);
        this.pending = pending.catch(() => {});
        return pending;
    }
    async flush(raw = this.board) { await this.persist(raw); await this.pending; }
}
module.exports = { WorkspaceRecovery };
